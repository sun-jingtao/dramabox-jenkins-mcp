// Jenkins API: read real build state, update BranchSpec, and trigger builds.

import { normalizeBaseUrl, requireEnv } from "./env.js";
import { normalizeRepo, type JobInfo } from "./match.js";

const FETCH_TIMEOUT_MS = 15_000;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface JenkinsClientOptions {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  user?: string;
  token?: string;
}

export class JenkinsHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number
  ) {
    super(`Jenkins ${path} 返回 ${status}`);
  }
}

function authHeader(user: string, token: string): string {
  return `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
}

// ─── config.xml pure functions ──────────────────────────────────────────────

/** Normalize Jenkins/Git branch labels to a bare branch name. */
export function stripBranchPrefix(name: string): string {
  return name
    .trim()
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")
    .replace(/^\*\//, "");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function setBranchInConfigXml(
  xml: string,
  newBranch: string
): { updated: string; oldBranch: string } {
  const match = /(<hudson\.plugins\.git\.BranchSpec>\s*<name>)([^<]*)(<\/name>)/.exec(xml);
  if (!match) throw new Error("config.xml 中未找到 BranchSpec，无法改分支");
  const oldBranch = stripBranchPrefix(unescapeXml(match[2]));
  const updated = xml.replace(match[0], () => `${match[1]}${escapeXml(newBranch)}${match[3]}`);
  return { updated, oldBranch };
}

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

// ─── build model and parsers ────────────────────────────────────────────────

export type BuildTrigger =
  | { kind: "user"; label: string }
  | { kind: "cause"; label: string };

interface BuildCause {
  userId?: string;
  userName?: string;
  shortDescription?: string;
}

export function parseBuildTrigger(causes: BuildCause[]): BuildTrigger | undefined {
  const userName = causes.find((cause) => cause.userName)?.userName;
  if (userName) return { kind: "user", label: userName };
  const description = causes.find((cause) => cause.shortDescription)?.shortDescription;
  return description ? { kind: "cause", label: description } : undefined;
}

export interface GitRevisionInfo {
  sha: string;
  branches: string[];
  remoteUrls: string[];
  scmName?: string;
}

export interface JenkinsBuildInfo {
  number: number;
  result: string;
  building: boolean;
  startedAt: number;
  duration: number;
  completedAt: number;
  url: string;
  trigger?: BuildTrigger;
  revision?: GitRevisionInfo;
}

interface RawBuildAction {
  _class?: string;
  causes?: BuildCause[];
  lastBuiltRevision?: {
    SHA1?: string;
    branch?: { name?: string; SHA1?: string }[];
  };
  remoteUrls?: string[];
  scmName?: string;
}

interface RawBuild {
  number: number;
  result: string | null;
  timestamp: number;
  duration?: number;
  url: string;
  building: boolean;
  actions?: RawBuildAction[];
}

/** Select the Git Plugin BuildData action for the Job repository. */
export function parseBuildRevision(
  actions: RawBuildAction[],
  jobRepo: string | null
): GitRevisionInfo | undefined {
  if (!jobRepo) return undefined;
  const matches = actions.filter((action) => {
    if (!action.lastBuiltRevision?.SHA1) return false;
    return (action.remoteUrls ?? []).some((url) => normalizeRepo(url) === jobRepo);
  });
  if (matches.length !== 1) return undefined;

  const action = matches[0];
  const branches = [
    ...new Set(
      (action.lastBuiltRevision?.branch ?? [])
        .map((branch) => stripBranchPrefix(branch.name ?? ""))
        .filter(Boolean)
    ),
  ];
  return {
    sha: action.lastBuiltRevision!.SHA1!,
    branches,
    remoteUrls: [...new Set(action.remoteUrls ?? [])],
    scmName: action.scmName || undefined,
  };
}

function parseBuild(raw: RawBuild, jobRepo: string | null): JenkinsBuildInfo {
  const duration = raw.duration ?? 0;
  const causes = (raw.actions ?? []).flatMap((action) => action.causes ?? []);
  return {
    number: raw.number,
    result: raw.building ? "BUILDING" : (raw.result ?? "?"),
    building: raw.building,
    startedAt: raw.timestamp,
    duration,
    completedAt: raw.timestamp + duration,
    url: raw.url,
    trigger: parseBuildTrigger(causes),
    revision: parseBuildRevision(raw.actions ?? [], jobRepo),
  };
}

export function getUniqueRevisionBranch(revision?: GitRevisionInfo): string | null {
  return revision?.branches.length === 1 ? revision.branches[0] : null;
}

export interface JobActivity {
  inQueue: boolean;
  queueId?: number;
  queueReason?: string;
  lastBuild: JenkinsBuildInfo | null;
}

export interface JobStatus extends JobInfo {
  configuredBranch: string;
  lastBuild: JenkinsBuildInfo | null;
  activityError?: string;
  deployedBuild: JenkinsBuildInfo | null;
  deployedBuildError?: string;
  inQueue: boolean;
  queueId?: number;
  queueReason?: string;
  deployUrls: string[];
}

const BUILD_TREE =
  "number,result,timestamp,duration,url,building,actions[_class,causes[userId,userName,shortDescription],lastBuiltRevision[SHA1,branch[name,SHA1]],remoteUrls,scmName]";

// ─── injectable client ──────────────────────────────────────────────────────

export function createJenkinsClient(options: JenkinsClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const connection = () => ({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? requireEnv("JENKINS_URL")),
    user: options.user ?? requireEnv("JENKINS_USER"),
    token: options.token ?? requireEnv("JENKINS_TOKEN"),
  });

  const jenkinsGet = async (path: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> => {
    const { baseUrl, user, token } = connection();
    const response = await fetchImpl(baseUrl + path, {
      headers: { Authorization: authHeader(user, token) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new JenkinsHttpError(path, response.status);
    return response.text();
  };

  const jenkinsPost = async (path: string, body?: string, contentType?: string): Promise<Response> => {
    const { baseUrl, user, token } = connection();
    const headers: Record<string, string> = { Authorization: authHeader(user, token) };
    if (contentType) headers["Content-Type"] = contentType;
    const signal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let response = await fetchImpl(baseUrl + path, { method: "POST", headers, body, signal: signal() });
    if (response.status === 403) {
      const crumbResponse = await fetchImpl(baseUrl + "/crumbIssuer/api/json", {
        headers: { Authorization: authHeader(user, token) },
        signal: signal(),
      });
      if (crumbResponse.ok) {
        const { crumb, crumbRequestField } = (await crumbResponse.json()) as {
          crumb: string;
          crumbRequestField: string;
        };
        const cookie = crumbResponse.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .find((value) => /session/i.test(value));
        const retryHeaders = { ...headers, [crumbRequestField]: crumb };
        if (cookie) retryHeaders.Cookie = cookie;
        response = await fetchImpl(baseUrl + path, {
          method: "POST",
          headers: retryHeaders,
          body,
          signal: signal(),
        });
      }
    }
    if (!response.ok) throw new JenkinsHttpError(`POST ${path}`, response.status);
    return response;
  };

  const updateJobBranch = async (name: string, newBranch: string): Promise<string> => {
    const xml = await jenkinsGet(`/job/${encodeURIComponent(name)}/config.xml`);
    let result;
    try {
      result = setBranchInConfigXml(xml, newBranch);
    } catch (error) {
      throw new Error(`Job ${name} 的 ${(error as Error).message}`);
    }
    await jenkinsPost(
      `/job/${encodeURIComponent(name)}/config.xml`,
      result.updated,
      "application/xml;charset=UTF-8"
    );
    return result.oldBranch;
  };

  const triggerBuild = async (name: string): Promise<number | null> => {
    const response = await jenkinsPost(`/job/${encodeURIComponent(name)}/build`);
    try {
      const queueUrl = response.headers.get("location");
      if (!queueUrl) return null;
      const { baseUrl } = connection();
      const basePath = new URL(baseUrl).pathname.replace(/\/$/, "");
      let itemPath = new URL(queueUrl, baseUrl + "/").pathname;
      if (basePath && itemPath.startsWith(basePath)) itemPath = itemPath.slice(basePath.length);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const item = JSON.parse(await jenkinsGet(`${itemPath}api/json`, remaining)) as {
          executable?: { number: number };
        };
        if (item.executable) return item.executable.number;
      }
    } catch {
      // The build was triggered successfully; queue-number lookup is best effort.
    }
    return null;
  };

  const getJobActivity = async (name: string, jobRepo: string | null): Promise<JobActivity> => {
    const raw = JSON.parse(
      await jenkinsGet(
        `/job/${encodeURIComponent(name)}/api/json?tree=inQueue,queueItem[id,why],lastBuild[${BUILD_TREE}]`
      )
    ) as {
      inQueue?: boolean;
      queueItem?: { id?: number; why?: string } | null;
      lastBuild?: RawBuild | null;
    };
    return {
      inQueue: raw.inQueue === true,
      queueId: raw.queueItem?.id,
      queueReason: raw.queueItem?.why || undefined,
      lastBuild: raw.lastBuild ? parseBuild(raw.lastBuild, jobRepo) : null,
    };
  };

  const getJobStatus = async (name: string): Promise<JobStatus> => {
    const xml = await jenkinsGet(`/job/${encodeURIComponent(name)}/config.xml`);
    const config = parseJobConfig(xml);
    const description = unescapeXml(xml.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "");
    const deployUrls = [...new Set(description.match(/https?:\/\/[^\s<>"']+/g) ?? [])];

    let activity: JobActivity = { inQueue: false, lastBuild: null };
    let activityError: string | undefined;
    try {
      activity = await getJobActivity(name, config.repo);
    } catch (error) {
      activityError = (error as Error).message;
    }

    let deployedBuild: JenkinsBuildInfo | null = null;
    let deployedBuildError: string | undefined;
    try {
      const raw = JSON.parse(
        await jenkinsGet(`/job/${encodeURIComponent(name)}/lastStableBuild/api/json?tree=${BUILD_TREE}`)
      ) as RawBuild;
      if (raw.result !== "SUCCESS" || raw.building) {
        deployedBuildError = `lastStableBuild 返回 ${raw.building ? "BUILDING" : (raw.result ?? "空状态")}，不是严格 SUCCESS`;
      } else {
        deployedBuild = parseBuild(raw, config.repo);
      }
    } catch (error) {
      if (!(error instanceof JenkinsHttpError && error.status === 404)) {
        deployedBuildError = (error as Error).message;
      }
    }

    return {
      name,
      ...config,
      configuredBranch: config.branch,
      lastBuild: activity.lastBuild,
      activityError,
      deployedBuild,
      deployedBuildError,
      inQueue: activity.inQueue,
      queueId: activity.queueId,
      queueReason: activity.queueReason,
      deployUrls,
    };
  };

  const listJenkinsJobs = async (): Promise<JobInfo[]> => {
    const { jobs } = JSON.parse(
      await jenkinsGet(
        "/api/json?tree=jobs[name,_class,scm[_class,userRemoteConfigs[url],branches[name]]]"
      )
    ) as {
      jobs: {
        name: string;
        _class?: string;
        scm?: {
          _class?: string;
          userRemoteConfigs?: { url?: string }[];
          branches?: { name?: string }[];
        } | null;
      }[];
    };
    return jobs.map(({ name, _class, scm }) => {
      if (_class && /folder/i.test(_class)) {
        return { name, remote: "", repo: null, branch: "", folder: true };
      }
      const remoteConfigs = scm?.userRemoteConfigs ?? [];
      const branches = scm?.branches ?? [];
      const remote = remoteConfigs[0]?.url ?? "";
      return {
        name,
        remote,
        repo: remote ? normalizeRepo(remote) : null,
        branch: stripBranchPrefix(branches[0]?.name ?? ""),
        multiScm: remoteConfigs.length > 1 || branches.length > 1 || undefined,
      };
    });
  };

  return {
    jenkinsGet,
    updateJobBranch,
    triggerBuild,
    getJobActivity,
    getJobStatus,
    listJenkinsJobs,
  };
}

export type JenkinsClient = ReturnType<typeof createJenkinsClient>;

const defaultClient = createJenkinsClient();

export const jenkinsGet = defaultClient.jenkinsGet;
export const updateJobBranch = defaultClient.updateJobBranch;
export const triggerBuild = defaultClient.triggerBuild;
export const getJobActivity = defaultClient.getJobActivity;
export const getJobStatus = defaultClient.getJobStatus;
export const listJenkinsJobs = defaultClient.listJenkinsJobs;
