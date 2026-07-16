// ─── 自检：守护 normalizeRepo 归一化与 matchJobs 匹配规则（每条断言对应一个真实踩过的坑）─
// 纯函数、无需 env；跑法：npm run self-check

import { matchJobs, normalizeRepo, type JobInfo } from "./match.js";

export function runSelfCheck(): void {
  const eq = (a: string | null, b: string | null) => {
    if (a !== b) throw new Error(`self-check 失败: ${a} !== ${b}`);
  };
  // IP ↔ 域名归一到同一别名（HOST_ALIAS）
  eq(normalizeRepo("git@192.168.0.31:fe/dramabox_other.git"), "gitlab31:fe/dramabox_other");
  eq(normalizeRepo("https://gitlab31.dhwaj.cn/fe/dramabox_other.git"), "gitlab31:fe/dramabox_other");
  // 实测边界：无 .git 后缀 / 前导斜杠（haiwai-affiliate-marketing 真实写法）
  eq(normalizeRepo("git@192.168.0.31:fe/dramabox_lite_other"), "gitlab31:fe/dramabox_lite_other");
  eq(normalizeRepo("git@192.168.0.31:/fe/haiwai-affiliate-marketing.git"), "gitlab31:fe/haiwai-affiliate-marketing");
  // ssh 端口写法 / 大小写 / 尾斜杠
  eq(normalizeRepo("ssh://git@gitlab31.dhwaj.cn:2222/fe/dramabox_other.git/"), "gitlab31:fe/dramabox_other");
  eq(normalizeRepo("HTTP://GitLab31.dhwaj.cn/FE/App"), "gitlab31:fe/app");
  // 保留 host：跨实例同名 path 不得相等
  if (normalizeRepo("git@192.168.0.31:fe/x.git") === normalizeRepo("git@192.168.0.110:fe/x.git")) {
    throw new Error("self-check 失败: 跨实例同名 path 不应相等");
  }
  // 子串陷阱：other ≠ other_webpay
  if (normalizeRepo("git@192.168.0.31:fe/dramabox_other_webpay.git") === "gitlab31:fe/dramabox_other") {
    throw new Error("self-check 失败: 子串陷阱");
  }

  // ── matchJobs：精确过滤与不回退 ──
  const jobs: JobInfo[] = [
    { name: "TEST-hot-dramabox-other", remote: "git@192.168.0.31:fe/dramabox_other.git", repo: "gitlab31:fe/dramabox_other", branch: "master" },
    { name: "TEST-hot-fe-dramabox-webpay", remote: "git@192.168.0.31:fe/dramabox_other_webpay.git", repo: "gitlab31:fe/dramabox_other_webpay", branch: "test" },
    { name: "job-no-scm", remote: "", repo: null, branch: "" },
  ];
  const projects = [
    { path: "fe/dramabox_other", key: "gitlab31:fe/dramabox_other" },
    { path: "fe/dramabox_other_webpay", key: "gitlab31:fe/dramabox_other_webpay" },
  ];
  // GitLab search 模糊召回两个项目时，关键词精确命中 → 只匹配精确项，webpay 不得混入
  const hits = matchJobs(jobs, projects, "dramabox_other");
  if (hits.length !== 1 || hits[0].name !== "TEST-hot-dramabox-other") {
    throw new Error(`self-check 失败: matchJobs 精确过滤，实际 ${hits.map((j) => j.name).join(",")}`);
  }
  // GitLab 无命中 → 空结果，绝不回退为子串匹配
  if (matchJobs(jobs, [], "dramabox").length !== 0) {
    throw new Error("self-check 失败: matchJobs 不得模糊回退");
  }
  // env 过滤按 Job 名
  if (matchJobs(jobs, projects, "dramabox_other_webpay", "hot").length !== 1) {
    throw new Error("self-check 失败: matchJobs env 过滤");
  }
  console.log("self-check ok");
}
