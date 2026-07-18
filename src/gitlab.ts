// GitLab API: project lookup, target-branch validation, and commit ancestry.

import { requireEnv } from "./env.js";
import { normalizeRepo, type GitlabProject } from "./match.js";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface GitlabClientOptions {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  token?: string;
}

export interface ProjectRef {
  id: number;
  defaultBranch: string;
}

export interface MergeStatus {
  state: "merged" | "not_merged" | "unknown";
  detail: string;
}

export function createGitlabClient(options: GitlabClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const connection = () => ({
    baseUrl: (options.baseUrl ?? requireEnv("GITLAB_URL")).replace(/\/+$/, ""),
    token: options.token ?? requireEnv("GITLAB_TOKEN"),
  });

  const gitlabGet = async <T>(path: string): Promise<T | null> => {
    const { baseUrl, token } = connection();
    const response = await fetchImpl(`${baseUrl}/api/v4${path}`, {
      headers: { "PRIVATE-TOKEN": token },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitLab ${path} 返回 ${response.status}`);
    return (await response.json()) as T;
  };

  const searchGitlabProjects = async (keyword: string): Promise<GitlabProject[]> => {
    const projects = await gitlabGet<
      { path_with_namespace: string; http_url_to_repo: string }[]
    >(`/projects?membership=true&simple=true&per_page=100&search=${encodeURIComponent(keyword)}`);
    return (projects ?? []).map((project) => ({
      path: project.path_with_namespace,
      key: normalizeRepo(project.http_url_to_repo),
    }));
  };

  const getProjectByPath = async (path: string): Promise<ProjectRef | null> => {
    const project = await gitlabGet<{ id: number; default_branch: string }>(
      `/projects/${encodeURIComponent(path)}`
    );
    return project ? { id: project.id, defaultBranch: project.default_branch } : null;
  };

  const branchExists = async (project: ProjectRef, branch: string): Promise<boolean> => {
    const result = await gitlabGet<{ name: string }>(
      `/projects/${project.id}/repository/branches/${encodeURIComponent(branch)}`
    );
    return result !== null;
  };

  const queryCommitMergedToDefaultBranch = async (
    project: ProjectRef,
    deployedSha: string
  ): Promise<boolean | null> => {
    const params = new URLSearchParams();
    params.append("refs[]", deployedSha);
    params.append("refs[]", project.defaultBranch);
    const mergeBase = await gitlabGet<{ id: string }>(
      `/projects/${project.id}/repository/merge_base?${params.toString()}`
    );
    return mergeBase ? mergeBase.id.toLowerCase() === deployedSha.toLowerCase() : null;
  };

  /** true = deployed SHA is on default branch; false = explicitly not; null = unknown. */
  const isCommitMergedToDefaultBranch = async (
    project: ProjectRef,
    deployedSha: string
  ): Promise<boolean | null> => {
    try {
      return await queryCommitMergedToDefaultBranch(project, deployedSha);
    } catch {
      return null;
    }
  };

  const findMergedMr = async (project: ProjectRef, branch: string) =>
    gitlabGet<{ iid: number }[]>(
      `/projects/${project.id}/merge_requests?source_branch=${encodeURIComponent(branch)}&target_branch=${encodeURIComponent(project.defaultBranch)}&state=merged&per_page=1`
    );

  const getCommitMergeStatus = async (
    project: ProjectRef,
    deployedSha: string,
    deployedBranch?: string | null
  ): Promise<MergeStatus> => {
    let merged: boolean | null;
    try {
      merged = await queryCommitMergedToDefaultBranch(project, deployedSha);
    } catch (error) {
      return {
        state: "unknown",
        detail: `GitLab merge_base 查询失败：${(error as Error).message}`,
      };
    }
    if (merged === true) {
      return {
        state: "merged",
        detail: `${deployedSha.slice(0, 8)} 已进入主干 ${project.defaultBranch}`,
      };
    }
    if (merged === null) {
      return {
        state: "unknown",
        detail: `无法确认 ${deployedSha.slice(0, 8)} 是否已进入主干 ${project.defaultBranch}`,
      };
    }

    let squashHint = "";
    if (deployedBranch && deployedBranch !== project.defaultBranch) {
      try {
        const mergeRequests = await findMergedMr(project, deployedBranch);
        if (mergeRequests && mergeRequests.length > 0) {
          squashHint = `；发现来源分支 ${deployedBranch} 的已合并 MR !${mergeRequests[0].iid}，可能经过 squash，请人工确认后 force`;
        }
      } catch {
        // MR is diagnostic only and must not change the ancestry decision.
      }
    }
    return {
      state: "not_merged",
      detail: `${deployedSha.slice(0, 8)} 尚未进入主干 ${project.defaultBranch}${squashHint}`,
    };
  };

  return {
    gitlabGet,
    searchGitlabProjects,
    getProjectByPath,
    branchExists,
    isCommitMergedToDefaultBranch,
    getCommitMergeStatus,
  };
}

export type GitlabClient = ReturnType<typeof createGitlabClient>;

const defaultClient = createGitlabClient();

export const searchGitlabProjects = defaultClient.searchGitlabProjects;
export const getProjectByPath = defaultClient.getProjectByPath;
export const branchExists = defaultClient.branchExists;
export const isCommitMergedToDefaultBranch = defaultClient.isCommitMergedToDefaultBranch;
export const getCommitMergeStatus = defaultClient.getCommitMergeStatus;
