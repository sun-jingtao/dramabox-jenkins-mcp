// ─── Jenkins API：读 Job 配置、改 BranchSpec、触发构建 ──────────────────────

import { requireEnv } from "./env.js";
import { normalizeRepo, type JobInfo } from "./match.js";

function authHeader(): string {
  return `Basic ${Buffer.from(`${requireEnv("JENKINS_USER")}:${requireEnv("JENKINS_TOKEN")}`).toString("base64")}`;
}

/** GET {JENKINS_URL}{path}，Basic Auth */
export async function jenkinsGet(path: string): Promise<string> {
  const res = await fetch(requireEnv("JENKINS_URL") + path, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`Jenkins ${path} 返回 ${res.status}`);
  return res.text();
}

/**
 * POST，自适应 CSRF：API token 通常免 Crumb（Jenkins 2.96+），先直接发；
 * 若 403 再取 crumbIssuer（带回 session cookie）重试一次，两种实例配置都兼容。
 */
async function jenkinsPost(path: string, body?: string, contentType?: string): Promise<Response> {
  const base = requireEnv("JENKINS_URL");
  const headers: Record<string, string> = { Authorization: authHeader() };
  if (contentType) headers["Content-Type"] = contentType;

  let res = await fetch(base + path, { method: "POST", headers, body });
  if (res.status === 403) {
    const crumbRes = await fetch(base + "/crumbIssuer/api/json", {
      headers: { Authorization: authHeader() },
    });
    if (crumbRes.ok) {
      const { crumb, crumbRequestField } = (await crumbRes.json()) as {
        crumb: string;
        crumbRequestField: string;
      };
      const cookie = crumbRes.headers.get("set-cookie")?.split(";")[0];
      const retryHeaders = { ...headers, [crumbRequestField]: crumb };
      if (cookie) retryHeaders["Cookie"] = cookie;
      res = await fetch(base + path, { method: "POST", headers: retryHeaders, body });
    }
  }
  if (!res.ok) throw new Error(`Jenkins POST ${path} 返回 ${res.status}`);
  return res;
}

/**
 * 把 Job 的第一个 BranchSpec 改为 newBranch（GET config.xml → 精确替换该节点 → POST 写回）。
 * 返回改动前的分支名。config 其余内容原样保留。
 */
export async function updateJobBranch(name: string, newBranch: string): Promise<string> {
  const xml = await jenkinsGet(`/job/${encodeURIComponent(name)}/config.xml`);
  const m = /(<hudson\.plugins\.git\.BranchSpec>\s*<name>)([^<]*)(<\/name>)/.exec(xml);
  if (!m) throw new Error(`Job ${name} 的 config.xml 中未找到 BranchSpec，无法改分支`);
  const oldBranch = m[2];
  const updated = xml.replace(m[0], `${m[1]}${escapeXml(newBranch)}${m[3]}`);
  await jenkinsPost(`/job/${encodeURIComponent(name)}/config.xml`, updated, "application/xml");
  // 同步 jobCache，否则同进程内 find_job 会继续报旧分支
  const cached = jobCache?.find((j) => j.name === name);
  if (cached) cached.branch = newBranch;
  return oldBranch;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 触发构建；尽力从 queue 拿到构建号（排队未起则返回 null，附 Job 链接足够人工跟进） */
export async function triggerBuild(name: string): Promise<number | null> {
  const res = await jenkinsPost(`/job/${encodeURIComponent(name)}/build`);
  const queueUrl = res.headers.get("location"); // http://.../queue/item/123/
  if (!queueUrl) return null;
  const itemPath = new URL(queueUrl).pathname; // /queue/item/123/
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const item = JSON.parse(await jenkinsGet(`${itemPath}api/json`)) as {
        executable?: { number: number };
      };
      if (item.executable) return item.executable.number;
    } catch {
      break; // queue item 已被清理等，放弃取号
    }
  }
  return null;
}

/** 从 config.xml 抠出 remote / 归一化键 / 分支（listJenkinsJobs 与 getJobStatus 共用） */
function parseJobConfig(xml: string): Pick<JobInfo, "remote" | "repo" | "branch"> {
  const remote =
    xml.match(/<hudson\.plugins\.git\.UserRemoteConfig>[\s\S]*?<url>([^<]+)<\/url>/)?.[1] ?? "";
  const branch =
    xml.match(/<hudson\.plugins\.git\.BranchSpec>\s*<name>([^<]+)<\/name>/)?.[1] ?? "";
  return { remote, repo: remote ? normalizeRepo(remote) : null, branch };
}

export interface LastBuild {
  number: number;
  result: string; // SUCCESS / FAILURE / ABORTED / BUILDING…
  timestamp: number;
  url: string;
}

export interface JobStatus extends JobInfo {
  lastBuild: LastBuild | null; // null = 从未构建
  deployUrls: string[]; // Job 描述里的 URL（部署页线索；README 约定拼路径太脆，不做）
}

/** 单个 Job 的当前配置 + 最近一次构建（Job 不存在时抛错） */
export async function getJobStatus(name: string): Promise<JobStatus> {
  const xml = await jenkinsGet(`/job/${encodeURIComponent(name)}/config.xml`);
  const desc = xml.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "";
  const deployUrls = [...new Set(desc.match(/https?:\/\/[^\s<>"'&]+/g) ?? [])];
  let lastBuild: LastBuild | null = null;
  try {
    const b = JSON.parse(
      await jenkinsGet(
        `/job/${encodeURIComponent(name)}/lastBuild/api/json?tree=number,result,timestamp,url,building`
      )
    ) as { number: number; result: string | null; timestamp: number; url: string; building: boolean };
    lastBuild = {
      number: b.number,
      result: b.building ? "BUILDING" : (b.result ?? "?"),
      timestamp: b.timestamp,
      url: b.url,
    };
  } catch {
    // lastBuild 404 = 从未构建，不是错误
  }
  return { name, ...parseJobConfig(xml), lastBuild, deployUrls };
}

// ponytail: 进程内缓存全量 Job；Cursor 重启即刷新。不够新鲜时再加 TTL。
let jobCache: JobInfo[] | null = null;

/**
 * 接口：
 * 1) GET /api/json?tree=jobs[name]  → 全量 Job 名
 * 2) GET /job/{name}/config.xml     → 解析 git remote + BranchSpec
 */
export async function listJenkinsJobs(): Promise<JobInfo[]> {
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
          out.push({ name, ...parseJobConfig(xml) });
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
