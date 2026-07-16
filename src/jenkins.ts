// ─── Jenkins API：读 Job 配置；后续 deploy 的改 BranchSpec / 触发构建也放这里 ──

import { requireEnv } from "./env.js";
import { normalizeRepo, type JobInfo } from "./match.js";

/** GET {JENKINS_URL}{path}，Basic Auth */
export async function jenkinsGet(path: string): Promise<string> {
  const auth = Buffer.from(`${requireEnv("JENKINS_USER")}:${requireEnv("JENKINS_TOKEN")}`).toString("base64");
  const res = await fetch(requireEnv("JENKINS_URL") + path, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Jenkins ${path} 返回 ${res.status}`);
  return res.text();
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
}

/** 单个 Job 的当前配置 + 最近一次构建（Job 不存在时抛错） */
export async function getJobStatus(name: string): Promise<JobStatus> {
  const xml = await jenkinsGet(`/job/${encodeURIComponent(name)}/config.xml`);
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
  return { name, ...parseJobConfig(xml), lastBuild };
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
