// ─── MCP 工具的注册与编排（find_job / 后续 get_status / deploy…）────────────
// 排版约定：注册（工具目录）在最上，往下依次是各工具的编排函数、格式化等细节。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { requireEnv } from "./env.js";
import { getJobStatus, listJenkinsJobs, triggerBuild, updateJobBranch } from "./jenkins.js";
import { branchExists, getMergeStatus, getProjectByPath, searchGitlabProjects, type MergeStatus } from "./gitlab.js";
import { appendDeployLog, readDeployLog } from "./history.js";
import { auditWarnings, matchJobs, type GitlabProject } from "./match.js";

// ─── 注册：全部 MCP 工具的目录 ───────────────────────────────────────────────

export function registerTools(server: McpServer): void {
  server.registerTool(
    "find_job",
    {
      title: "定位 Jenkins Job",
      description:
        "按 GitLab 仓库定位 Jenkins HOT/QAT 候选 Job，返回 Job 名、当前分支、仓库地址和链接。多环境时返回列表供确认。",
      inputSchema: {
        repo: z.string().describe("GitLab 仓库名或关键词，如 dramabox_other"),
        env: z.enum(["hot", "qat"]).optional().describe("环境过滤：hot / qat；不传则返回全部候选"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, env: envFilter }) => ({
      content: [{ type: "text" as const, text: await runFindJob(repo, envFilter) }],
    })
  );

  server.registerTool(
    "get_status",
    {
      title: "查看 Job 部署状态",
      description:
        "查看 Jenkins Job 的当前部署分支、最近构建结果，以及该分支相对主干的合并状态（deploy 防覆盖检查的依据）。",
      inputSchema: {
        job: z.string().describe("Jenkins Job 精确名称（可先用 find_job 定位），如 TEST-hot-dramabox-other"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ job }) => ({
      content: [{ type: "text" as const, text: await runGetStatus(job) }],
    })
  );

  server.registerTool(
    "deploy",
    {
      title: "部署分支到 Job",
      description:
        "把 Jenkins Job 的部署分支改为指定分支并触发构建。内置防覆盖检查：当前分支未合并进主干（或无法确认）时会中止并告警，此时必须先向用户复述告警内容并获得明确同意，才能带 force=true 重试。",
      inputSchema: {
        job: z.string().describe("Jenkins Job 精确名称（可先用 find_job 定位）"),
        branch: z.string().describe("要部署的目标分支名"),
        force: z
          .boolean()
          .optional()
          .describe("覆盖确认：仅在用户明确同意覆盖未合并/无法确认的分支后才传 true"),
      },
    },
    async ({ job, branch, force }) => ({
      content: [{ type: "text" as const, text: await runDeploy(job, branch, force) }],
    })
  );

  server.registerTool(
    "list_history",
    {
      title: "查看部署记录",
      description: "查看本工具执行过的分支切换与构建记录（最新在前）。",
      inputSchema: {
        job: z.string().optional().describe("Jenkins Job 名；不传则返回全部 Job 的记录"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ job }) => ({
      content: [{ type: "text" as const, text: runListHistory(job) }],
    })
  );

  server.registerTool(
    "rollback",
    {
      title: "回滚到上一个分支",
      description:
        "把 Job 切回部署记录中最近一次分支变更前的分支并构建。内部走 deploy 同一套防覆盖检查，被拦截时同样需向用户确认后带 force=true。",
      inputSchema: {
        job: z.string().describe("Jenkins Job 精确名称"),
        force: z
          .boolean()
          .optional()
          .describe("覆盖确认：仅在用户明确同意覆盖未合并/无法确认的分支后才传 true"),
      },
    },
    async ({ job, force }) => ({
      content: [{ type: "text" as const, text: await runRollback(job, force) }],
    })
  );
}

// ─── find_job ────────────────────────────────────────────────────────────────

/** 按仓库关键词定位候选 Job：GitLab 搜项目 → 归一化键全等匹配 Jenkins Job → env 过滤，附 audit 告警 */
export async function runFindJob(repo: string, envFilter?: "hot" | "qat"): Promise<string> {
  const jobs = await listJenkinsJobs();
  let projects: GitlabProject[];
  try {
    projects = await searchGitlabProjects(repo);
  } catch (e) {
    // 失败必须显式报出，绝不静默降级为模糊匹配（下游是 deploy，错配代价高于中止）
    return `GitLab 查询失败：${(e as Error).message}。为避免误匹配已中止，请检查 GITLAB_URL / GITLAB_TOKEN 后重试。`;
  }
  const hits = matchJobs(jobs, projects, repo, envFilter);

  if (hits.length === 0) {
    const gitlabHint = projects.map((p) => p.path).join("、") || "无";
    return (
      `未找到匹配 Job（repo=${repo}${envFilter ? `, env=${envFilter}` : ""}）。GitLab 命中项目：${gitlabHint}` +
      auditWarnings(jobs)
    );
  }

  const base = requireEnv("JENKINS_URL");
  const list = [
    `找到 ${hits.length} 个候选 Job：`,
    ...hits.map(
      (j) =>
        `- ${j.name}\n  当前分支: ${j.branch}\n  仓库: ${j.remote}\n  Job 链接: ${base}/job/${encodeURIComponent(j.name)}/`
    ),
  ].join("\n");
  return list + auditWarnings(jobs);
}

// ─── get_status ──────────────────────────────────────────────────────────────

/** 查看 Job 当前分支、最近构建，及分支相对主干的合并状态（防覆盖判断依据） */
export async function runGetStatus(job: string): Promise<string> {
  let status;
  try {
    status = await getJobStatus(job);
  } catch (e) {
    return `读取 Job 失败：${(e as Error).message}。请确认 Job 名称精确无误（可先用 find_job 定位）。`;
  }

  const lines = [`Job: ${job}`, `当前部署分支: ${status.branch || "(未配置)"}`];

  lines.push(
    status.lastBuild
      ? `最近构建: #${status.lastBuild.number} ${status.lastBuild.result} (${new Date(status.lastBuild.timestamp).toLocaleString("zh-CN")})\n  ${status.lastBuild.url}`
      : "最近构建: 从未构建"
  );
  if (status.deployUrls.length > 0) {
    lines.push(`部署页线索（来自 Job 描述）: ${status.deployUrls.join("  ")}`);
  }

  if (!status.repo) {
    lines.push("仓库: 未解析出 Git 仓库（无静态 SCM），无法判断合并状态");
    return lines.join("\n");
  }
  const repoPath = status.repo.split(":")[1];
  lines.push(`仓库: ${status.remote}`);

  // 合并状态：GitLab 查不到项目（另一实例/无权限）→ unknown，绝不猜测
  try {
    const project = await getProjectByPath(repoPath);
    if (!project) {
      lines.push(`合并状态: ⚠️ 无法确认 —— GitLab 上查不到 ${repoPath}（可能属于另一 GitLab 实例或当前 token 无权限）`);
    } else {
      const ms = await getMergeStatus(project, status.branch);
      const icon = { merged: "✅ 已合并", not_merged: "❌ 未合并", unknown: "⚠️ 无法确认" }[ms.state];
      lines.push(`合并状态: ${icon} —— ${ms.detail}`);
    }
  } catch (e) {
    lines.push(`合并状态: ⚠️ 无法确认 —— GitLab 查询失败：${(e as Error).message}`);
  }
  return lines.join("\n");
}

// ─── deploy ──────────────────────────────────────────────────────────────────

/** 防覆盖检查 → 改 BranchSpec → 触发构建 → 写操作日志 */
export async function runDeploy(job: string, branch: string, force = false): Promise<string> {
  let status;
  try {
    status = await getJobStatus(job);
  } catch (e) {
    return `读取 Job 失败：${(e as Error).message}。请确认 Job 名称精确无误（可先用 find_job 定位）。`;
  }
  const current = status.branch;
  const repoPath = status.repo?.split(":")[1];
  const project = repoPath ? await getProjectByPath(repoPath).catch(() => null) : null;

  // 防覆盖检查（PRD 第 4 节）：仅在换分支时需要；查不到项目一律按「无法确认」处理
  if (current && current !== branch && !force) {
    const ms: MergeStatus = project
      ? await getMergeStatus(project, current).catch(
          (e) => ({ state: "unknown", detail: `GitLab 查询失败：${(e as Error).message}` }) as MergeStatus
        )
      : { state: "unknown", detail: `GitLab 上查不到 ${repoPath ?? "该仓库"}（另一实例或无权限）` };
    if (ms.state !== "merged") {
      return [
        `🛑 已中止部署。当前分支 ${current} ${ms.state === "not_merged" ? "尚未合并进主干" : "合并状态无法确认"}：${ms.detail}`,
        `覆盖它可能丢失他人未合并的改动。请向用户确认后，带 force=true 重新调用 deploy。`,
      ].join("\n");
    }
  }

  // 目标分支存在性校验（查得到项目才校验，防打错字触发必败构建）
  if (project && branch !== current) {
    const exists = await branchExists(project, branch).catch(() => true); // 查询失败不拦（Jenkins 会兜底报错）
    if (!exists) {
      return `🛑 已中止部署。GitLab 仓库 ${repoPath} 上不存在分支 ${branch}，请检查分支名。`;
    }
  }

  // 执行：改分支（同分支跳过）→ 触发构建 → 记账
  let from = current;
  if (current !== branch) {
    from = await updateJobBranch(job, branch);
  }
  const build = await triggerBuild(job);
  appendDeployLog({ time: new Date().toISOString(), job, from, to: branch, build });

  const base = requireEnv("JENKINS_URL");
  return [
    `✅ 已部署 ${job}`,
    `分支: ${from === branch ? `${branch}（未变更，直接重新构建）` : `${from} → ${branch}`}`,
    build
      ? `构建: #${build}  ${base}/job/${encodeURIComponent(job)}/${build}/`
      : `构建: 已入队（构建号未及取到）  ${base}/job/${encodeURIComponent(job)}/`,
  ].join("\n");
}

// ─── list_history ────────────────────────────────────────────────────────────

/** 部署记录，最新在前，最多 20 条 */
export function runListHistory(job?: string): string {
  const recs = readDeployLog(job).slice(0, 20);
  if (recs.length === 0) {
    return `暂无部署记录${job ? `（job=${job}）` : ""}。只有经本工具 deploy/rollback 的操作才会入账。`;
  }
  return recs
    .map((r) => {
      const t = new Date(r.time).toLocaleString("zh-CN");
      const change = r.from === r.to ? `${r.to}（重新构建）` : `${r.from} → ${r.to}`;
      return `- [${t}] ${r.job}  ${change}${r.build ? `  #${r.build}` : ""}`;
    })
    .join("\n");
}

// ─── rollback ────────────────────────────────────────────────────────────────

/** 从账本找最近一次分支变更，切回变更前的分支；执行与防覆盖检查复用 runDeploy */
export async function runRollback(job: string, force = false): Promise<string> {
  const recs = readDeployLog(job);
  if (recs.length === 0) {
    return `无法回滚：${job} 没有部署记录。只有经本工具 deploy 的分支切换才可回滚。`;
  }
  const lastChange = recs.find((r) => r.from !== r.to);
  if (!lastChange) {
    return `无法回滚：${job} 的记录里只有重新构建，没有分支变更。`;
  }
  const result = await runDeploy(job, lastChange.from, force);
  return `回滚目标: ${lastChange.to} 切回 ${lastChange.from}（依据 ${new Date(lastChange.time).toLocaleString("zh-CN")} 的记录）\n${result}`;
}
