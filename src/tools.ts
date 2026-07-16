import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ─── 配置：Token 常驻本地进程，不进对话 ───────────────────────────────────────

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {
  // 无 .env 时走 process.env（mcp.json env 注入）
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`缺少环境变量 ${key}，请在项目根目录 .env 中配置`);
  return v.replace(/\/+$/, "");
}

// ─── 仓库地址归一化（匹配键）─────────────────────────────────────────────────
// Jenkins remote 常用内网 IP，GitLab API 返回域名；host 对不上，匹配只用 group/repo。

/** ssh/http/大小写/.git 等写法 → host/group/repo */
export function normalizeRepo(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/:(\d+\/)?/, "/")
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
}

/** 去掉 host，只留 group/repo，供跨 host 匹配 */
export function repoPath(url: string): string {
  return normalizeRepo(url).split("/").slice(1).join("/");
}

// ─── Jenkins API ─────────────────────────────────────────────────────────────

interface JobInfo {
  name: string;
  remote: string;
  branch: string;
}

/** GET {JENKINS_URL}{path}，Basic Auth */
async function jenkinsGet(path: string): Promise<string> {
  const auth = Buffer.from(`${requireEnv("JENKINS_USER")}:${requireEnv("JENKINS_TOKEN")}`).toString("base64");
  const res = await fetch(requireEnv("JENKINS_URL") + path, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Jenkins ${path} 返回 ${res.status}`);
  return res.text();
}

// ponytail: 进程内缓存全量 Job；Cursor 重启即刷新。不够新鲜时再加 TTL。
let jobCache: JobInfo[] | null = null;

/**
 * 接口：
 * 1) GET /api/json?tree=jobs[name]  → 全量 Job 名
 * 2) GET /job/{name}/config.xml     → 解析 git remote + BranchSpec
 */
async function listJenkinsJobs(): Promise<JobInfo[]> {
  if (jobCache) return jobCache;

  const { jobs } = JSON.parse(await jenkinsGet("/api/json?tree=jobs[name]")) as {
    jobs: { name: string }[];
  };

  const out: JobInfo[] = [];
  for (let i = 0; i < jobs.length; i += 10) {
    await Promise.all(
      jobs.slice(i, i + 10).map(async ({ name }) => {
        try {
          const xml = await jenkinsGet(`/job/${encodeURIComponent(name)}/config.xml`);
          const remote = xml.match(
            /<hudson\.plugins\.git\.UserRemoteConfig>[\s\S]*?<url>([^<]+)<\/url>/
          )?.[1];
          if (!remote) return;
          const branch =
            xml.match(/<hudson\.plugins\.git\.BranchSpec>\s*<name>([^<]+)<\/name>/)?.[1] ?? "";
          out.push({ name, remote, branch });
        } catch {
          // 个别 Job 无权限 / 读失败，跳过
        }
      })
    );
  }

  jobCache = out;
  return out;
}

// ─── GitLab API ──────────────────────────────────────────────────────────────

interface GitlabProject {
  path: string;
  key: string;
}

/**
 * 接口：GET /api/v4/projects?membership=true&simple=true&search={keyword}
 * 用 PRIVATE-TOKEN 鉴权；返回当前用户有权限且名称命中的仓库。
 */
async function searchGitlabProjects(keyword: string): Promise<GitlabProject[]> {
  const res = await fetch(
    `${requireEnv("GITLAB_URL")}/api/v4/projects?membership=true&simple=true&per_page=100&search=${encodeURIComponent(keyword)}`,
    { headers: { "PRIVATE-TOKEN": requireEnv("GITLAB_TOKEN") } }
  );
  if (!res.ok) throw new Error(`GitLab 搜索返回 ${res.status}`);

  const list = (await res.json()) as { path_with_namespace: string; http_url_to_repo: string }[];
  return list.map((p) => ({
    path: p.path_with_namespace,
    key: repoPath(p.http_url_to_repo),
  }));
}

// ─── 工具：find_job ──────────────────────────────────────────────────────────

/**
 * 用 GitLab 仓库路径过滤 Jenkins Job。
 * - GitLab 有命中：Job.remote 的 group/repo 必须在命中集合里（精确）
 * - GitLab 无命中：退化为 Job.remote 子串包含 repo 关键词
 * - envFilter：Job 名包含 hot / qat
 */
function matchJobs(
  jobs: JobInfo[],
  projects: GitlabProject[],
  repo: string,
  envFilter?: "hot" | "qat"
): JobInfo[] {
  const keys = new Set(projects.map((p) => p.key));
  const keyword = repo.toLowerCase();

  let hits = jobs.filter((j) => {
    const path = repoPath(j.remote);
    return keys.size > 0 ? keys.has(path) : path.includes(keyword);
  });

  if (envFilter) {
    hits = hits.filter((j) => j.name.toLowerCase().includes(envFilter));
  }
  return hits;
}

/** 把候选 Job 拼成 Agent 可读文本 */
function formatJobList(
  hits: JobInfo[],
  repo: string,
  projects: GitlabProject[],
  envFilter?: "hot" | "qat"
): string {
  if (hits.length === 0) {
    const gitlabHint = projects.map((p) => p.path).join("、") || "无";
    return `未找到匹配 Job（repo=${repo}${envFilter ? `, env=${envFilter}` : ""}）。GitLab 命中项目：${gitlabHint}`;
  }

  const base = requireEnv("JENKINS_URL");
  return [
    `找到 ${hits.length} 个候选 Job：`,
    ...hits.map(
      (j) =>
        `- ${j.name}\n  当前分支: ${j.branch}\n  仓库: ${j.remote}\n  Job 链接: ${base}/job/${encodeURIComponent(j.name)}/`
    ),
  ].join("\n");
}

/**
 * 按仓库关键词定位 Jenkins HOT/QAT 候选 Job。
 *
 * 参数：
 * - repo：GitLab 仓库名或关键词（如 dramabox_other）
 * - env：可选，hot | qat，按 Job 名过滤
 *
 * 处理流程：
 * 1. GitLab search 拿仓库 path
 * 2. Jenkins 扫全量 Job config（remote + branch）
 * 3. 用 group/repo 匹配，再按 env 过滤
 * 4. 拼成文本返回（Job 名 / 当前分支 / remote / 链接）
 */
export async function runFindJob(repo: string, envFilter?: "hot" | "qat"): Promise<string> {
  const [projects, jobs] = await Promise.all([
    searchGitlabProjects(repo).catch(() => [] as GitlabProject[]),
    listJenkinsJobs(),
  ]);
  const hits = matchJobs(jobs, projects, repo, envFilter);
  return formatJobList(hits, repo, projects, envFilter);
}

/** 注册全部 MCP 工具 */
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
