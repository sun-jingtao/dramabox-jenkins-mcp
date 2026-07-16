// ─── GitLab API：搜项目；后续防覆盖的 compare / MR 合并状态查询也放这里 ──────

import { requireEnv } from "./env.js";
import { normalizeRepo, type GitlabProject } from "./match.js";

/**
 * 接口：GET /api/v4/projects?membership=true&simple=true&search={keyword}
 * 用 PRIVATE-TOKEN 鉴权；返回当前用户有权限且名称命中的仓库。
 */
export async function searchGitlabProjects(keyword: string): Promise<GitlabProject[]> {
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
