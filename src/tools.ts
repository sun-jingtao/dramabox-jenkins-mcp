// MCP tools and orchestration (find_job / get_status / deploy).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { requireEnv } from "./env.js";
import {
  branchExists,
  getCommitMergeStatus,
  getProjectByPath,
  searchGitlabProjects,
  type MergeStatus,
  type ProjectRef,
} from "./gitlab.js";
import {
  getJobActivity,
  getJobStatus,
  getUniqueRevisionBranch,
  listJenkinsJobs,
  stripBranchPrefix,
  triggerBuild,
  updateJobBranch,
  type JenkinsBuildInfo,
  type JobActivity,
  type JobStatus,
} from "./jenkins.js";
import {
  DEPLOYMENT_ENVS,
  auditWarnings,
  gitlabInstanceAlias,
  matchJobs,
  type DeploymentEnv,
  type GitlabProject,
  type JobInfo,
} from "./match.js";

export interface ToolDependencies {
  listJenkinsJobs: () => Promise<JobInfo[]>;
  getJobStatus: (name: string) => Promise<JobStatus>;
  getJobActivity: (name: string, jobRepo: string | null) => Promise<JobActivity>;
  updateJobBranch: (name: string, branch: string) => Promise<string>;
  triggerBuild: (name: string) => Promise<number | null>;
  searchGitlabProjects: (keyword: string) => Promise<GitlabProject[]>;
  getProjectByPath: (path: string) => Promise<ProjectRef | null>;
  branchExists: (project: ProjectRef, branch: string) => Promise<boolean>;
  getCommitMergeStatus: (
    project: ProjectRef,
    deployedSha: string,
    deployedBranch?: string | null
  ) => Promise<MergeStatus>;
  gitlabUrl: () => string;
  jenkinsUrl: () => string;
}

const defaultDependencies: ToolDependencies = {
  listJenkinsJobs,
  getJobStatus,
  getJobActivity,
  updateJobBranch,
  triggerBuild,
  searchGitlabProjects,
  getProjectByPath,
  branchExists,
  getCommitMergeStatus,
  gitlabUrl: () => requireEnv("GITLAB_URL"),
  jenkinsUrl: () => requireEnv("JENKINS_URL"),
};

function sameGitlabInstance(repo: string, deps: ToolDependencies): boolean {
  return repo.split(":")[0] === gitlabInstanceAlias(deps.gitlabUrl());
}

function buildTriggerText(build: JenkinsBuildInfo): string {
  if (!build.trigger) return "";
  return build.trigger.kind === "user"
    ? `，由 ${build.trigger.label} 触发`
    : `，${build.trigger.label}`;
}

function buildRevisionText(build: JenkinsBuildInfo): string {
  if (!build.revision) return "Git revision 无法确定";
  const branch = getUniqueRevisionBranch(build.revision);
  const branchText = branch ?? (build.revision.branches.length > 0
    ? `[${build.revision.branches.join(", ")}]`
    : "未知分支");
  return `${branchText}@${build.revision.sha.slice(0, 8)}`;
}

function concurrencyBlock(activity: Pick<JobStatus, "inQueue" | "queueId" | "queueReason" | "lastBuild">): string | null {
  if (activity.lastBuild?.building) {
    return [
      `🛑 已中止部署：Jenkins #${activity.lastBuild.number} 正在构建，不能通过 force 绕过。`,
      activity.lastBuild.url,
      "请等待构建完成，或确认后到 Jenkins UI abort。",
    ].join("\n");
  }
  if (activity.inQueue) {
    const queue = activity.queueId !== undefined ? ` #${activity.queueId}` : "";
    const reason = activity.queueReason ? `：${activity.queueReason}` : "";
    return [
      `🛑 已中止部署：Job 已在 Jenkins queue${queue}${reason}，不能通过 force 绕过。`,
      "请等待任务离开队列，或确认后到 Jenkins UI cancel。",
    ].join("\n");
  }
  return null;
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "find_job",
    {
      title: "定位 Jenkins Job",
      description:
        "按 GitLab 仓库定位 Jenkins HOT/QAT/QAT2 候选 Job，返回 Job 名、Jenkins 当前配置分支、仓库地址和链接。",
      inputSchema: {
        repo: z.string().describe("GitLab 仓库名或关键词，如 dramabox_other"),
        env: z.enum(DEPLOYMENT_ENVS).optional().describe("环境过滤：hot / qat / qat2；不传则返回全部候选"),
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
        "查看 Jenkins 当前配置、最近构建尝试、最近一次严格成功部署及其相对主干的合并状态。",
      inputSchema: {
        job: z.string().describe("Jenkins Job 精确名称（可先用 find_job 定位）"),
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
        "修改 BranchSpec 并触发构建。并发构建会硬拦截；同一实际部署分支可直接重部署，切换分支时基于最近成功部署 SHA 防覆盖。",
      inputSchema: {
        job: z.string().describe("Jenkins Job 精确名称（可先用 find_job 定位）"),
        branch: z.string().describe("要部署的目标分支名"),
        force: z
          .boolean()
          .optional()
          .describe("仅在用户明确同意覆盖未合并或无法确认的成功部署版本后传 true"),
      },
    },
    async ({ job, branch, force }) => ({
      content: [{ type: "text" as const, text: await runDeploy(job, branch, force) }],
    })
  );
}

export async function runFindJob(
  repo: string,
  envFilter?: DeploymentEnv,
  deps: ToolDependencies = defaultDependencies
): Promise<string> {
  const jobs = await deps.listJenkinsJobs();
  let projects: GitlabProject[];
  try {
    projects = await deps.searchGitlabProjects(repo);
  } catch (error) {
    return `GitLab 查询失败：${(error as Error).message}。为避免误匹配已中止，请检查配置后重试。`;
  }
  const hits = matchJobs(jobs, projects, repo, envFilter);
  const truncateWarning = projects.length >= 100
    ? "\n\n⚠️ GitLab 搜索命中已达单页上限 100，召回可能被截断；请用更精确的仓库名重试。"
    : "";
  if (hits.length === 0) {
    const gitlabHint = projects.map((project) => project.path).join("、") || "无";
    return (
      `未找到匹配 Job（repo=${repo}${envFilter ? `, env=${envFilter}` : ""}）。GitLab 命中项目：${gitlabHint}` +
      truncateWarning +
      auditWarnings(jobs)
    );
  }

  const base = deps.jenkinsUrl();
  return [
    `找到 ${hits.length} 个候选 Job：`,
    ...hits.map(
      (job) =>
        `- ${job.name}\n  Jenkins 当前配置分支: ${job.branch}\n  仓库: ${job.remote}\n  Job 链接: ${base}/job/${encodeURIComponent(job.name)}/`
    ),
  ].join("\n") + truncateWarning + auditWarnings(jobs);
}

export async function runGetStatus(
  job: string,
  deps: ToolDependencies = defaultDependencies
): Promise<string> {
  let status: JobStatus;
  try {
    status = await deps.getJobStatus(job);
  } catch (error) {
    return `读取 Job 失败：${(error as Error).message}。请确认 Job 名称精确无误（可先用 find_job 定位）。`;
  }

  const lines = [
    `Job: ${job}`,
    `Jenkins 当前配置分支: ${status.configuredBranch || "(未配置)"}`,
  ];
  if (status.inQueue) {
    lines.push(
      `队列状态: IN_QUEUE${status.queueId !== undefined ? ` #${status.queueId}` : ""}${status.queueReason ? ` —— ${status.queueReason}` : ""}`
    );
  }

  if (status.activityError) {
    lines.push(`最近构建尝试: ⚠️ 查询失败 —— ${status.activityError}`);
  } else if (status.lastBuild) {
    lines.push(
      [
        `最近构建尝试: #${status.lastBuild.number} ${status.lastBuild.result}`,
        `  ${buildRevisionText(status.lastBuild)}`,
        `  开始时间: ${new Date(status.lastBuild.startedAt).toLocaleString("zh-CN")}${buildTriggerText(status.lastBuild)}`,
        `  ${status.lastBuild.url}`,
      ].join("\n")
    );
  } else {
    lines.push("最近构建尝试: 从未构建");
  }

  if (status.deployedBuildError) {
    lines.push(`最近一次成功部署: ⚠️ 查询失败 —— ${status.deployedBuildError}`);
  } else if (status.deployedBuild) {
    lines.push(
      [
        `最近一次成功部署: #${status.deployedBuild.number} SUCCESS`,
        `  ${buildRevisionText(status.deployedBuild)}`,
        `  完成时间: ${new Date(status.deployedBuild.completedAt).toLocaleString("zh-CN")}${buildTriggerText(status.deployedBuild)}`,
        `  ${status.deployedBuild.url}`,
      ].join("\n")
    );
  } else {
    lines.push(
      "最近一次成功部署: ⚠️ 无法确认。可能是新 Job 首次部署、构建历史已轮转，或 Jenkins 没有严格 SUCCESS 记录。"
    );
  }

  if (status.deployUrls.length > 0) {
    lines.push(`部署页线索（来自 Job 描述）: ${status.deployUrls.join("  ")}`);
  }
  if (!status.repo) {
    lines.push("仓库: 未解析出静态 Git 仓库，无法判断成功部署版本的合并状态");
    return lines.join("\n");
  }
  lines.push(`仓库: ${status.remote}`);
  if (!status.deployedBuild) {
    return lines.join("\n");
  }
  const revision = status.deployedBuild.revision;
  if (!revision) {
    lines.push("成功部署版本合并状态: ⚠️ 无法确认 —— lastStableBuild 缺少匹配当前仓库的 Git BuildData");
    return lines.join("\n");
  }
  if (!sameGitlabInstance(status.repo, deps)) {
    lines.push(
      `成功部署版本合并状态: ⚠️ 无法确认 —— Job 仓库属于 ${status.repo.split(":")[0]}，当前连接 ${gitlabInstanceAlias(deps.gitlabUrl())}`
    );
    return lines.join("\n");
  }

  const repoPath = status.repo.split(":")[1];
  try {
    const project = await deps.getProjectByPath(repoPath);
    if (!project) {
      lines.push(`成功部署版本合并状态: ⚠️ 无法确认 —— GitLab 上查不到 ${repoPath}`);
    } else {
      const merge = await deps.getCommitMergeStatus(
        project,
        revision.sha,
        getUniqueRevisionBranch(revision)
      );
      const label = {
        merged: "✅ 已进入主干",
        not_merged: "❌ 尚未进入主干",
        unknown: "⚠️ 无法确认",
      }[merge.state];
      lines.push(`成功部署版本合并状态: ${label} —— ${merge.detail}`);
    }
  } catch (error) {
    lines.push(`成功部署版本合并状态: ⚠️ 无法确认 —— ${(error as Error).message}`);
  }
  return lines.join("\n");
}

export async function runDeploy(
  job: string,
  branch: string,
  force = false,
  deps: ToolDependencies = defaultDependencies
): Promise<string> {
  const targetBranch = stripBranchPrefix(branch);
  if (!targetBranch) return "🛑 已中止部署：目标分支名不能为空。";

  let status: JobStatus;
  try {
    status = await deps.getJobStatus(job);
  } catch (error) {
    return `读取 Job 失败：${(error as Error).message}。请确认 Job 名称精确无误（可先用 find_job 定位）。`;
  }
  if (status.activityError) {
    return `🛑 已中止部署：无法确认 Jenkins queue/BUILDING 状态（${status.activityError}），不能通过 force 绕过。`;
  }
  const activeBlock = concurrencyBlock(status);
  if (activeBlock) return activeBlock;

  const repoPath = status.repo?.split(":")[1];
  const crossInstance = !!status.repo && !sameGitlabInstance(status.repo, deps);
  let project: ProjectRef | null = null;
  let projectError = "";
  if (repoPath && !crossInstance) {
    try {
      project = await deps.getProjectByPath(repoPath);
      if (!project) projectError = `GitLab 上查不到 ${repoPath}（不存在或当前 token 无权限）`;
    } catch (error) {
      projectError = `GitLab 项目查询失败：${(error as Error).message}`;
    }
  } else if (crossInstance) {
    projectError = `Job 仓库属于另一 GitLab 实例 ${status.repo!.split(":")[0]}，当前连接 ${gitlabInstanceAlias(deps.gitlabUrl())}`;
  } else {
    projectError = "Job 未解析出静态 Git 仓库";
  }

  let branchCheckWarning = "";
  if (project) {
    try {
      if (!(await deps.branchExists(project, targetBranch))) {
        return `🛑 已中止部署：GitLab 仓库 ${repoPath} 上不存在分支 ${targetBranch}，请检查分支名。`;
      }
    } catch (error) {
      if (!force) {
        return [
          `🛑 已中止部署：目标分支存在性查询失败（${(error as Error).message}），尚未修改 Jenkins 配置。`,
          "请向用户复述以上信息并获得明确同意后，带 force=true 重试。",
        ].join("\n");
      }
      branchCheckWarning = `\n⚠️ 目标分支存在性查询失败（${(error as Error).message}）；已按用户确认使用 force=true 继续，由 Jenkins 最终校验分支。`;
    }
  }

  const revision = status.deployedBuild?.revision;
  const deployedBranch = getUniqueRevisionBranch(revision);
  const sameDeployedBranch = deployedBranch === targetBranch;
  let protectionWarning = branchCheckWarning;

  if (!project && !force) {
    return [
      "🛑 已中止部署：GitLab 仓库状态无法确认。",
      projectError,
      "无法校验目标分支及防覆盖状态。请向用户复述以上信息并获得明确同意后，带 force=true 重试。",
    ].join("\n");
  }

  if (!sameDeployedBranch && !force && project) {
    let merge: MergeStatus;
    if (!status.deployedBuild) {
      const reason = status.deployedBuildError
        ? `lastStableBuild 查询失败：${status.deployedBuildError}`
        : "没有可用的 lastStableBuild（可能是新 Job 或构建历史已轮转）";
      merge = { state: "unknown", detail: reason };
    } else if (!revision) {
      merge = { state: "unknown", detail: "lastStableBuild 缺少匹配当前仓库的 Git BuildData/SHA" };
    } else {
      merge = await deps
        .getCommitMergeStatus(project, revision.sha, deployedBranch)
        .catch((error) => ({
          state: "unknown" as const,
          detail: `GitLab 查询失败：${(error as Error).message}`,
        }));
    }
    if (merge.state !== "merged") {
      return [
        `🛑 已中止部署：最近成功部署版本${deployedBranch ? ` ${deployedBranch}` : ""}${revision ? `@${revision.sha.slice(0, 8)}` : ""} ${merge.state === "not_merged" ? "尚未进入主干" : "状态无法确认"}。`,
        merge.detail,
        "覆盖它可能丢失他人未合并的部署。请向用户复述以上信息并获得明确同意后，带 force=true 重试。",
      ].join("\n");
    }
  } else if (!sameDeployedBranch && force && project) {
    protectionWarning += "\n⚠️ 已按用户确认使用 force=true，跳过最近成功部署版本的主干合并保护。";
  } else if (!project) {
    protectionWarning += `\n⚠️ ${projectError}，本次 force 部署无法校验目标分支是否存在。`;
  }

  // Narrow the race between protection checks and the config write.
  let latestActivity: JobActivity;
  try {
    latestActivity = await deps.getJobActivity(job, status.repo);
  } catch (error) {
    return `🛑 已中止部署：写配置前无法再次确认 Jenkins queue/BUILDING 状态（${(error as Error).message}）。`;
  }
  const secondActiveBlock = concurrencyBlock(latestActivity);
  if (secondActiveBlock) return secondActiveBlock;

  let previousBranch = status.configuredBranch;
  try {
    if (status.configuredBranch !== targetBranch) {
      previousBranch = await deps.updateJobBranch(job, targetBranch);
    }
  } catch (error) {
    return `🛑 Jenkins 配置修改失败：${(error as Error).message}`;
  }

  let build: number | null;
  try {
    build = await deps.triggerBuild(job);
  } catch (error) {
    return [
      `⚠️ Jenkins 配置分支已${previousBranch === targetBranch ? `保持为 ${targetBranch}` : `从 ${previousBranch} 改为 ${targetBranch}`}，但构建触发失败：${(error as Error).message}`,
      `请到 Jenkins 检查并手动处理：${deps.jenkinsUrl()}/job/${encodeURIComponent(job)}/`,
    ].join("\n") + protectionWarning;
  }

  const jobUrl = `${deps.jenkinsUrl()}/job/${encodeURIComponent(job)}/`;
  return [
    `✅ 已触发 ${job} 构建`,
    `Jenkins 配置分支: ${previousBranch === targetBranch ? `${targetBranch}（未变更）` : `${previousBranch} → ${targetBranch}`}`,
    build !== null
      ? `构建: #${build}  ${jobUrl}${build}/`
      : `构建: 已入队（15 秒内未取得构建号）  ${jobUrl}`,
  ].join("\n") + protectionWarning;
}
