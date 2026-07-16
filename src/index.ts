#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---- .env：Token 常驻本地进程，不进对话 ----
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`缺少环境变量 ${key}，请在项目根目录 .env 中配置`);
  return v.replace(/\/+$/, "");
}

// git 远程地址归一化为 host/group/repo，使 ssh/http 写法可互相匹配
export function normalizeRepo(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "") // https:// ssh://
    .replace(/^[^@/]+@/, "") // git@
    .replace(/:(\d+\/)?/, "/") // git@host:group → host/group；host:2222/ → host/
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
}

// 取 group/repo 路径做匹配键：Jenkins remote 常用内网 IP，GitLab API 返回域名，host 对不上
export function repoPath(url: string): string {
  return normalizeRepo(url).split("/").slice(1).join("/");
}

async function jenkins(path: string): Promise<string> {
  const auth = Buffer.from(`${env("JENKINS_USER")}:${env("JENKINS_TOKEN")}`).toString("base64");
  const res = await fetch(env("JENKINS_URL") + path, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Jenkins ${path} 返回 ${res.status}`);
  return res.text();
}

interface JobInfo {
  name: string;
  remote: string;
  branch: string;
}

// ponytail: 进程内缓存全量 Job config，Cursor 重启即刷新；不够新鲜时再加 TTL
let jobCache: JobInfo[] | null = null;

async function scanJobs(): Promise<JobInfo[]> {
  if (jobCache) return jobCache;
  const { jobs } = JSON.parse(await jenkins("/api/json?tree=jobs[name]")) as { jobs: { name: string }[] };
  const out: JobInfo[] = [];
  for (let i = 0; i < jobs.length; i += 10) {
    await Promise.all(
      jobs.slice(i, i + 10).map(async ({ name }) => {
        try {
          const xml = await jenkins(`/job/${encodeURIComponent(name)}/config.xml`);
          const remote = xml.match(/<hudson\.plugins\.git\.UserRemoteConfig>[\s\S]*?<url>([^<]+)<\/url>/)?.[1];
          if (!remote) return; // 非 Git Job
          const branch = xml.match(/<hudson\.plugins\.git\.BranchSpec>\s*<name>([^<]+)<\/name>/)?.[1] ?? "";
          out.push({ name, remote, branch });
        } catch {
          // 个别 Job 无权限或读取失败，跳过不影响整体
        }
      })
    );
  }
  jobCache = out;
  return out;
}

async function gitlabSearch(keyword: string): Promise<{ path: string; key: string }[]> {
  const res = await fetch(
    `${env("GITLAB_URL")}/api/v4/projects?membership=true&simple=true&per_page=100&search=${encodeURIComponent(keyword)}`,
    { headers: { "PRIVATE-TOKEN": env("GITLAB_TOKEN") } }
  );
  if (!res.ok) throw new Error(`GitLab 搜索返回 ${res.status}`);
  const list = (await res.json()) as { path_with_namespace: string; http_url_to_repo: string }[];
  return list.map((p) => ({ path: p.path_with_namespace, key: repoPath(p.http_url_to_repo) }));
}

async function findJob(repo: string, envFilter?: "hot" | "qat"): Promise<string> {
  const [projects, jobs] = await Promise.all([gitlabSearch(repo).catch(() => []), scanJobs()]);
  const keys = projects.map((p) => p.key);
  let hits = jobs.filter((j) => {
    const r = repoPath(j.remote);
    // GitLab 命中则精确匹配仓库；查不到时退化为远程地址子串匹配
    return keys.length ? keys.includes(r) : r.includes(repo.toLowerCase());
  });
  if (envFilter) hits = hits.filter((j) => j.name.toLowerCase().includes(envFilter));
  if (!hits.length) {
    return `未找到匹配 Job（repo=${repo}${envFilter ? `, env=${envFilter}` : ""}）。GitLab 命中项目：${projects.map((p) => p.path).join("、") || "无"}`;
  }
  return [
    `找到 ${hits.length} 个候选 Job：`,
    ...hits.map(
      (j) =>
        `- ${j.name}\n  当前分支: ${j.branch}\n  仓库: ${j.remote}\n  Job 链接: ${env("JENKINS_URL")}/job/${encodeURIComponent(j.name)}/`
    ),
  ].join("\n");
}

// ---- 自检 / 命令行直连 / MCP 启动 ----
if (process.argv.includes("--self-check")) {
  const eq = (a: string, b: string) => {
    if (a !== b) throw new Error(`self-check 失败: ${a} !== ${b}`);
  };
  eq(normalizeRepo("git@gitlab.example.com:fe/dramabox_other.git"), "gitlab.example.com/fe/dramabox_other");
  eq(normalizeRepo("https://gitlab.example.com/fe/dramabox_other.git"), "gitlab.example.com/fe/dramabox_other");
  eq(normalizeRepo("ssh://git@gitlab.example.com:2222/fe/dramabox_other.git/"), "gitlab.example.com/fe/dramabox_other");
  eq(normalizeRepo("HTTP://GitLab.Example.com/FE/App"), "gitlab.example.com/fe/app");
  eq(repoPath("git@192.168.0.31:fe/haiwai_other.git"), repoPath("https://gitlab.example.com/fe/haiwai_other.git"));
  console.log("self-check ok");
} else if (process.argv[2] === "--find") {
  // 本地调试：node dist/index.js --find <repo> [hot|qat]
  console.log(await findJob(process.argv[3] ?? "", process.argv[4] as "hot" | "qat" | undefined));
} else {
  const server = new McpServer({ name: "dramabox-jenkins-mcp", version: "0.1.0" });
  server.registerTool(
    "find_job",
    {
      description:
        "按 GitLab 仓库定位 Jenkins HOT/QAT 候选 Job，返回 Job 名、当前分支、仓库地址和链接。多环境时返回列表供确认。",
      inputSchema: {
        repo: z.string().describe("GitLab 仓库名或关键词，如 dramabox_other"),
        env: z.enum(["hot", "qat"]).optional().describe("环境过滤，不传则返回全部候选"),
      },
    },
    async ({ repo, env: envFilter }) => ({
      content: [{ type: "text" as const, text: await findJob(repo, envFilter) }],
    })
  );
  await server.connect(new StdioServerTransport());
}
