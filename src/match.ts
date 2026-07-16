// ─── 仓库匹配核心：纯函数，无 IO ────────────────────────────────────────────
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

// ─── 共享类型（jenkins.ts / gitlab.ts 产出，此处消费）──────────────────────

export interface JobInfo {
  name: string;
  remote: string; // 原始 <url>；空串 = 无静态 SCM 或读取失败（进 audit 清单）
  repo: string | null; // 归一化匹配键 `host别名:group/repo`
  branch: string;
}

export interface GitlabProject {
  path: string;
  key: string | null;
}

// ─── 归一化 ─────────────────────────────────────────────────────────────────

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

// ─── 匹配 ───────────────────────────────────────────────────────────────────

/**
 * 用 GitLab 项目集合过滤 Jenkins Job：归一化键全等，无任何模糊回退。
 * - GitLab search 是模糊召回（"dramabox_other" 也会召回 "dramabox_other_webpay"）：
 *   若有项目名与关键词精确相等，则只用精确项，防止子串近邻混入候选。
 * - GitLab 无命中 → 直接空结果（由调用方提示），绝不降级为子串匹配。
 * - envFilter：Job 名包含 hot / qat
 */
export function matchJobs(
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
export function auditWarnings(jobs: JobInfo[]): string {
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
