// ─── Jenkins API：读 Job 配置、改 BranchSpec、触发构建 ──────────────────────

import { requireEnv } from "./env.js";
import { normalizeRepo, type JobInfo } from "./match.js";

// ponytail: 进程内缓存全量 Job；Cursor 重启即刷新。不够新鲜时再加 TTL。
// updateJobBranch 写成功后会就地更新对应项，保证同进程内读写一致。
let jobCache: JobInfo[] | null = null;

const FETCH_TIMEOUT_MS = 15_000; // 对端挂起时防止 MCP 工具调用永久阻塞

function authHeader(): string {
  return `Basic ${Buffer.from(`${requireEnv("JENKINS_USER")}:${requireEnv("JENKINS_TOKEN")}`).toString("base64")}`;
}

/** GET {JENKINS_URL}{path}，Basic Auth，带超时 */
export async function jenkinsGet(path: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const res = await fetch(requireEnv("JENKINS_URL") + path, {
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(timeoutMs),
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

  const signal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let res = await fetch(base + path, { method: "POST", headers, body, signal: signal() });
  if (res.status === 403) {
    const crumbRes = await fetch(base + "/crumbIssuer/api/json", {
      headers: { Authorization: authHeader() },
      signal: signal(),
    });
    if (crumbRes.ok) {
      const { crumb, crumbRequestField } = (await crumbRes.json()) as {
        crumb: string;
        crumbRequestField: string;
      };
      // 多个 Set-Cookie 会被 get() 合并成一串，须用 getSetCookie 逐个找会话 cookie
      const cookie = crumbRes.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .find((c) => /session/i.test(c));
      const retryHeaders = { ...headers, [crumbRequestField]: crumb };
      if (cookie) retryHeaders["Cookie"] = cookie;
      res = await fetch(base + path, { method: "POST", headers: retryHeaders, body, signal: signal() });
    }
  }
  if (!res.ok) throw new Error(`Jenkins POST ${path} 返回 ${res.status}`);
  return res;
}

// ─── config.xml 纯函数（无 IO，self-check 可测）────────────────────────────

/** BranchSpec 惯用前缀（星号斜杠、refs/heads/、origin/）剥成裸分支名，用于查 GitLab 与展示 */
export function stripBranchPrefix(name: string): string {
  return name.replace(/^(\*\/|refs\/heads\/|origin\/)/, "");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 反转义 XML 实体（数字实体先还原，&amp; 必须最后，防双重转义误还原） */
export function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 把 config.xml 第一个 BranchSpec 改为 newBranch，返回更新后的 xml 与改动前的裸分支名。
 * replace 第二参数必须用函数——字符串形式会把分支名里的 $$/$&/$`/$' 当替换模式解释，静默篡改 config。
 */
export function setBranchInConfigXml(
  xml: string,
  newBranch: string
): { updated: string; oldBranch: string } {
  const m = /(<hudson\.plugins\.git\.BranchSpec>\s*<name>)([^<]*)(<\/name>)/.exec(xml);
  if (!m) throw new Error("config.xml 中未找到 BranchSpec，无法改分支");
  const oldBranch = stripBranchPrefix(unescapeXml(m[2]));
  const updated = xml.replace(m[0], () => `${m[1]}${escapeXml(newBranch)}${m[3]}`);
  return { updated, oldBranch };
}

/** 从 config.xml 抠出 remote / 归一化键 / 裸分支名（listJenkinsJobs 与 getJobStatus 共用） */
function parseJobConfig(xml: string): Pick<JobInfo, "remote" | "repo" | "branch" | "multiScm"> {
  const remote =
    xml.match(/<hudson\.plugins\.git\.UserRemoteConfig>[\s\S]*?<url>([^<]+)<\/url>/)?.[1] ?? "";
  const rawBranch =
    xml.match(/<hudson\.plugins\.git\.BranchSpec>\s*<name>([^<]+)<\/name>/)?.[1] ?? "";
  const remoteCount = xml.match(/<hudson\.plugins\.git\.UserRemoteConfig>/g)?.length ?? 0;
  const specCount = xml.match(/<hudson\.plugins\.git\.BranchSpec>/g)?.length ?? 0;
  return {
    remote,
    repo: remote ? normalizeRepo(remote) : null,
    branch: stripBranchPrefix(unescapeXml(rawBranch)),
    multiScm: remoteCount > 1 || specCount > 1 || undefined,
  };
}

// ─── 写操作 ─────────────────────────────────────────────────────────────────

/**
 * 把 Job 的第一个 BranchSpec 改为 newBranch（GET config.xml → 精确替换该节点 → POST 写回）。
 * 返回改动前的裸分支名。config 其余内容原样保留。
 */
export async function updateJobBranch(name: string, newBranch: string): Promise<string> {
  const xml = await jenkinsGet(`/job/${encodeURIComponent(name)}/config.xml`);
  let result;
  try {
    result = setBranchInConfigXml(xml, newBranch);
  } catch (e) {
    throw new Error(`Job ${name} 的 ${(e as Error).message}`);
  }
  // charset=UTF-8 必带：Jenkins 2.470 对裸 application/xml 写回 config 返回 500（实测对照：
  // 裸 xml→HOT/QAT 均 500；带 charset→均 200。降 XML 声明 1.1→1.0 不充分，QAT 仍 500，故不改内容只改 header）
  await jenkinsPost(
    `/job/${encodeURIComponent(name)}/config.xml`,
    result.updated,
    "application/xml;charset=UTF-8"
  );
  // 同步 jobCache，否则同进程内 find_job 会继续报旧分支
  const cached = jobCache?.find((j) => j.name === name);
  if (cached) cached.branch = newBranch;
  return result.oldBranch;
}

/** 触发构建；尽力从 queue 拿到构建号（排队未起或轮询失败返回 null，附 Job 链接足够人工跟进） */
export async function triggerBuild(name: string): Promise<number | null> {
  const res = await jenkinsPost(`/job/${encodeURIComponent(name)}/build`);
  // 取构建号是尽力而为：任何解析/轮询失败都不该让已成功触发的构建被误报为失败
  try {
    const queueUrl = res.headers.get("location"); // http://.../queue/item/123/
    if (!queueUrl) return null;
    const base = requireEnv("JENKINS_URL");
    // JENKINS_URL 带 context path（如 /jenkins）时，Location 的 pathname 已含前缀，需减除防止重复拼接
    const basePath = new URL(base).pathname.replace(/\/$/, "");
    let itemPath = new URL(queueUrl, base + "/").pathname;
    if (basePath && itemPath.startsWith(basePath)) itemPath = itemPath.slice(basePath.length);
    // 15s 总窗口须盖住 quiet period + 执行器排队（真机实测约 10.5s）；使用绝对 deadline，
    // 避免 15 次请求各自再等待 15s，令 MCP 调用在慢 Jenkins 上远超预期。
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(1000, deadline - Date.now())));
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const item = JSON.parse(await jenkinsGet(`${itemPath}api/json`, remaining)) as {
        executable?: { number: number };
      };
      if (item.executable) return item.executable.number;
    }
  } catch {
    // queue item 已被清理 / URL 解析失败等，放弃取号
  }
  return null;
}

// ─── 读操作 ─────────────────────────────────────────────────────────────────

export interface LastBuild {
  number: number;
  result: string; // SUCCESS / FAILURE / ABORTED / BUILDING…
  timestamp: number;
  url: string;
  trigger?: BuildTrigger;
}

export type BuildTrigger =
  | { kind: "user"; label: string }
  | { kind: "cause"; label: string };

interface BuildCause {
  userName?: string;
  shortDescription?: string;
}

/** 人工触发优先返回用户名；否则保留 Jenkins 的完整 cause 描述，展示层不再二次包装。 */
export function parseBuildTrigger(causes: BuildCause[]): BuildTrigger | undefined {
  const userName = causes.find((cause) => cause.userName)?.userName;
  if (userName) return { kind: "user", label: userName };
  const description = causes.find((cause) => cause.shortDescription)?.shortDescription;
  return description ? { kind: "cause", label: description } : undefined;
}

export interface JobStatus extends JobInfo {
  lastBuild: LastBuild | null; // null = 从未构建（仅 404 时）
  lastBuildError?: string; // 非 404 的查询失败，不能与「从未构建」混淆
  deployUrls: string[]; // Job 描述里的 URL（部署页线索；README 约定拼路径太脆，不做）
}

/** 单个 Job 的当前配置 + 最近一次构建（Job 不存在时抛错） */
export async function getJobStatus(name: string): Promise<JobStatus> {
  const xml = await jenkinsGet(`/job/${encodeURIComponent(name)}/config.xml`);
  // description 在 config.xml 里是 XML 转义的，先还原实体再抽 URL，否则 ?a=1&b=2 会在 &amp; 处截断
  const desc = unescapeXml(xml.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "");
  const deployUrls = [...new Set(desc.match(/https?:\/\/[^\s<>"']+/g) ?? [])];
  let lastBuild: LastBuild | null = null;
  let lastBuildError: string | undefined;
  try {
    const b = JSON.parse(
      await jenkinsGet(
        `/job/${encodeURIComponent(name)}/lastBuild/api/json?tree=number,result,timestamp,url,building,actions[causes[userName,shortDescription]]`
      )
    ) as {
      number: number;
      result: string | null;
      timestamp: number;
      url: string;
      building: boolean;
      actions?: { causes?: BuildCause[] }[];
    };
    // tree 是白名单：不显式要 causes 字段 Jenkins 就不返回（此前「查不到部署人」的根因）
    const causes = (b.actions ?? []).flatMap((a) => a?.causes ?? []);
    lastBuild = {
      number: b.number,
      result: b.building ? "BUILDING" : (b.result ?? "?"),
      timestamp: b.timestamp,
      url: b.url,
      trigger: parseBuildTrigger(causes),
    };
  } catch (e) {
    // 仅 404 = 从未构建；5xx/超时等是查询失败，混淆两者会误导「Job 近期是否被占用」的判断
    if (!/返回 404$/.test((e as Error).message)) {
      lastBuildError = (e as Error).message;
    }
  }
  return { name, ...parseJobConfig(xml), lastBuild, lastBuildError, deployUrls };
}

/**
 * 接口：
 * 1) GET /api/json?tree=jobs[name,_class]  → 全量 Job 名 + 类型（识别 folder）
 * 2) GET /job/{name}/config.xml            → 解析 git remote + BranchSpec
 */
export async function listJenkinsJobs(): Promise<JobInfo[]> {
  if (jobCache) return jobCache;

  const { jobs } = JSON.parse(await jenkinsGet("/api/json?tree=jobs[name,_class]")) as {
    jobs: { name: string; _class?: string }[];
  };

  const out: JobInfo[] = [];
  for (let i = 0; i < jobs.length; i += 10) {
    await Promise.all(
      jobs.slice(i, i + 10).map(async ({ name, _class }) => {
        // folder 内的子 Job 当前接口拿不到，标记出来交给 audit 大声提示，不静默缺失
        if (_class && /folder/i.test(_class)) {
          out.push({ name, remote: "", repo: null, branch: "", folder: true });
          return;
        }
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
