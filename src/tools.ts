// ─── MCP 工具的注册与编排（find_job / 后续 get_status / deploy…）────────────
// 排版约定：注册（工具目录）在最上，往下依次是各工具的编排函数、格式化等细节。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { requireEnv } from "./env.js";
import { listJenkinsJobs } from "./jenkins.js";
import { searchGitlabProjects } from "./gitlab.js";
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
