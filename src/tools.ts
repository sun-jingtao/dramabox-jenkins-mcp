// ─── MCP 工具的注册与编排（find_job / 后续 get_status / deploy…）────────────
// 排版约定：注册（工具目录）在最上，往下依次是各工具的编排函数、格式化等细节。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { requireEnv } from "./env.js";
import { getJobStatus, listJenkinsJobs } from "./jenkins.js";
import { getMergeStatus, getProjectByPath, searchGitlabProjects } from "./gitlab.js";
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
