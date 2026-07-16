import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ─── 配置：仅从 MCP 宿主注入的 process.env 读取（mcp.json → env），不读 .env 文件 ─

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(`缺少环境变量 ${key}，请在 MCP 客户端配置的 env 中注入（勿写入对话）`);
  }
  return v.replace(/\/+$/, "");
}

// ─── 仓库地址归一化（匹配键）─────────────────────────────────────────────────
// 唯一硬约束是 Job 部署时真正 checkout 的仓库地址（config.xml 的 <url>）。
// 两端归一化成 `host别名:group/repo` 后全等比较；保留 host，跨实例同名 path 不会串。

// 校准旋钮：同一 GitLab 实例的内网 IP / 域名映射到同一别名。换 IP、加实例只改这张表；
// 表外的 host 会被 audit 报为形态漂移，不会静默漏配。
const HOST_ALIAS: Record<string, string> = {
  "192.168.0.31": "gitlab31",
  "gitlab31.dhwaj.cn": "gitlab31",
  "192.168.0.110": "gitlab110",
  "gitlab110.dhwaj.cn": "gitlab110",
};

/** 拆出 host 与 path；识别 git@host:path、ssh://git@host[:port]/path、http(s)://host[:port]/path */
function splitUrl(url: string): { host: string; path: string } | null {
  const u = url.trim().toLowerCase();
  const m =
    /^git@([^:/]+):(.+)$/.exec(u) ??
    /^ssh:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/.exec(u) ??
    /^https?:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/.exec(u);
  return m ? { host: m[1], path: m[2] } : null;
}

/**
 * ssh/http、IP↔域名、前导及连续斜杠、可选 .git、大小写 → `host别名:group/repo`。
 * 无法识别的地址返回 null（audit 会兜住，不静默）。
 */
export function normalizeRepo(url: string): string | null {
  const s = splitUrl(url);
  if (!s) return null;
  const path = s.path
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
  return `${HOST_ALIAS[s.host] ?? s.host}:${path}`;
}

/** host 是否已被别名表覆盖；未覆盖 = 形态漂移（如换 IP、新实例），进告警清单 */
function isKnownHost(url: string): boolean {
  const s = splitUrl(url);
  return !!s && s.host in HOST_ALIAS;
}

// ─── Jenkins API ─────────────────────────────────────────────────────────────

interface JobInfo {
  name: string;
  remote: string; // 原始 <url>；空串 = 无静态 SCM 或读取失败（进 audit 清单）
  repo: string | null; // 归一化匹配键 `host别名:group/repo`
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
          const remote =
            xml.match(
              /<hudson\.plugins\.git\.UserRemoteConfig>[\s\S]*?<url>([^<]+)<\/url>/
            )?.[1] ?? "";
          const branch =
            xml.match(/<hudson\.plugins\.git\.BranchSpec>\s*<name>([^<]+)<\/name>/)?.[1] ?? "";
          out.push({ name, remote, repo: remote ? normalizeRepo(remote) : null, branch });
        } catch {
          // 无权限 / 读失败也入列（remote 空），audit 可见，不静默丢
          out.push({ name, remote: "", repo: null, branch: "" });
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
  key: string | null;
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
    key: normalizeRepo(p.http_url_to_repo),
  }));
}

// ─── 工具：find_job ──────────────────────────────────────────────────────────

/**
 * 用 GitLab 项目集合过滤 Jenkins Job：归一化键全等，无任何模糊回退。
 * - GitLab search 是模糊召回（"dramabox_other" 也会召回 "dramabox_other_webpay"）：
 *   若有项目名与关键词精确相等，则只用精确项，防止子串近邻混入候选。
 * - GitLab 无命中 → 直接空结果（提示见 formatJobList），绝不降级为子串匹配。
 * - envFilter：Job 名包含 hot / qat
 */
function matchJobs(
  jobs: JobInfo[],
  projects: GitlabProject[],
  repo: string,
  envFilter?: "hot" | "qat"
): JobInfo[] {
  const kw = repo.trim().toLowerCase();
  const exact = projects.filter(
    (p) => p.path.toLowerCase() === kw || p.path.toLowerCase().split("/").pop() === kw
  );
  const scope = exact.length > 0 ? exact : projects;
  const keys = new Set(scope.map((p) => p.key).filter((k): k is string => k !== null));

  let hits = jobs.filter((j) => j.repo !== null && keys.has(j.repo));
  if (envFilter) {
    hits = hits.filter((j) => j.name.toLowerCase().includes(envFilter));
  }
  return hits;
}

// ─── 对账告警：数据形态漂移时大声失败，绝不静默漏配 ─────────────────────────

/** 非空即漂移信号；unknownHost 需补 HOST_ALIAS 一行配置后重启生效 */
function auditWarnings(jobs: JobInfo[]): string {
  const noScm = jobs.filter((j) => !j.remote).map((j) => j.name);
  const unknownHost = jobs
    .filter((j) => j.remote && !isKnownHost(j.remote))
    .map((j) => `${j.name} → ${j.remote}`);

  const parts: string[] = [];
  if (unknownHost.length > 0) {
    parts.push(
      `⚠️ ${unknownHost.length} 个 Job 的仓库 host 不在 HOST_ALIAS 别名表内（形态漂移，无法参与匹配，请补配置）：\n${unknownHost.map((s) => `  - ${s}`).join("\n")}`
    );
  }
  if (noScm.length > 0) {
    parts.push(
      `⚠️ ${noScm.length} 个 Job 未解析出 Git 仓库（无静态 SCM / Pipeline 动态 checkout / 读取失败）：${noScm.join("、")}`
    );
  }
  return parts.length > 0 ? "\n\n" + parts.join("\n") : "";
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
  const jobs = await listJenkinsJobs();
  let projects: GitlabProject[];
  try {
    projects = await searchGitlabProjects(repo);
  } catch (e) {
    // 失败必须显式报出，绝不静默降级为模糊匹配（下游是 deploy，错配代价高于中止）
    return `GitLab 查询失败：${(e as Error).message}。为避免误匹配已中止，请检查 GITLAB_URL / GITLAB_TOKEN 后重试。`;
  }
  const hits = matchJobs(jobs, projects, repo, envFilter);
  return formatJobList(hits, repo, projects, envFilter) + auditWarnings(jobs);
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
