// ─── GitLab API：搜项目、compare / MR 合并状态查询（防覆盖判断的数据源）─────

import { requireEnv } from "./env.js";
import { normalizeRepo, type GitlabProject } from "./match.js";

/** GET /api/v4{path}，PRIVATE-TOKEN 鉴权；404 返回 null，其余非 2xx 抛错 */
async function gitlabGet<T>(path: string): Promise<T | null> {
  const res = await fetch(`${requireEnv("GITLAB_URL")}/api/v4${path}`, {
    headers: { "PRIVATE-TOKEN": requireEnv("GITLAB_TOKEN") },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitLab ${path} 返回 ${res.status}`);
  return (await res.json()) as T;
}

/**
 * 接口：GET /api/v4/projects?membership=true&simple=true&search={keyword}
 * 用 PRIVATE-TOKEN 鉴权；返回当前用户有权限且名称命中的仓库。
 */
export async function searchGitlabProjects(keyword: string): Promise<GitlabProject[]> {
  const list = await gitlabGet<{ path_with_namespace: string; http_url_to_repo: string }[]>(
    `/projects?membership=true&simple=true&per_page=100&search=${encodeURIComponent(keyword)}`
  );
  return (list ?? []).map((p) => ({
    path: p.path_with_namespace,
    key: normalizeRepo(p.http_url_to_repo),
  }));
}

// ─── 合并状态（PRD 防覆盖规则）──────────────────────────────────────────────

export interface ProjectRef {
  id: number;
  defaultBranch: string;
}

/** 按 path_with_namespace 精确取项目；查不到（不存在/无权限/另一 GitLab 实例）返回 null */
export async function getProjectByPath(path: string): Promise<ProjectRef | null> {
  const p = await gitlabGet<{ id: number; default_branch: string }>(
    `/projects/${encodeURIComponent(path)}`
  );
  return p ? { id: p.id, defaultBranch: p.default_branch } : null;
}

/** 分支当前是否存在于仓库（deploy 目标分支校验用） */
export async function branchExists(project: ProjectRef, branch: string): Promise<boolean> {
  const b = await gitlabGet<{ name: string }>(
    `/projects/${project.id}/repository/branches/${encodeURIComponent(branch)}`
  );
  return b !== null;
}

export interface MergeStatus {
  state: "merged" | "not_merged" | "unknown";
  detail: string;
}

/**
 * 判断分支是否已进入主干（PRD 第 4 节）：
 * - 是主干本身 → merged
 * - 分支存在 → compare 主干..分支，0 个独有提交 = merged，否则 not_merged
 * - 分支已删除 → 只认 merged MR 记录；查不到 = unknown（不能仅凭分支不存在判定已合并）
 */
export async function getMergeStatus(project: ProjectRef, branch: string): Promise<MergeStatus> {
  const target = project.defaultBranch;
  if (branch === target) {
    return { state: "merged", detail: `就是主干分支 ${target}` };
  }

  const findMergedMr = () =>
    gitlabGet<{ iid: number }[]>(
      `/projects/${project.id}/merge_requests?source_branch=${encodeURIComponent(branch)}&target_branch=${encodeURIComponent(target)}&state=merged&per_page=1`
    );

  const exists = await gitlabGet<{ name: string }>(
    `/projects/${project.id}/repository/branches/${encodeURIComponent(branch)}`
  );
  if (exists) {
    const cmp = await gitlabGet<{ commits: unknown[] }>(
      `/projects/${project.id}/repository/compare?from=${encodeURIComponent(target)}&to=${encodeURIComponent(branch)}`
    );
    if (!cmp) return { state: "unknown", detail: "compare 接口查询失败" };
    if (cmp.commits.length === 0) {
      return { state: "merged", detail: `分支提交已全部进入 ${target}` };
    }
    // squash 合并后 tip 不在主干，compare 恒有领先；补查 merged MR 供人判断，但不放松拦截
    // （MR 合并后分支可能又有新提交，自动放行有覆盖风险）
    const mrs = await findMergedMr();
    const squashHint =
      mrs && mrs.length > 0
        ? `；存在已合并 MR !${mrs[0].iid} 但 compare 仍领先——可能是 squash 合并，也可能合并后又有新提交，确认无未合并改动后可 force`
        : "";
    return {
      state: "not_merged",
      detail: `领先 ${target} ${cmp.commits.length} 个提交，覆盖部署前需确认${squashHint}`,
    };
  }

  const mrs = await findMergedMr();
  if (mrs && mrs.length > 0) {
    return { state: "merged", detail: `分支已删除，存在已合并 MR !${mrs[0].iid}` };
  }
  return { state: "unknown", detail: "分支已删除且无已合并 MR 记录，无法确认，覆盖部署前需人工核对" };
}
