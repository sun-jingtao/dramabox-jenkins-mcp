// ─── 自检：守护 normalizeRepo 归一化与 matchJobs 匹配规则（每条断言对应一个真实踩过的坑）─
// 纯函数、无需 env；跑法：npm run self-check

import { setBranchInConfigXml, stripBranchPrefix, unescapeXml } from "./jenkins.js";
import { gitlabInstanceAlias, matchJobs, normalizeRepo, type JobInfo } from "./match.js";

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
  // ── 跨实例守卫的实例别名解析（GITLAB_URL → 别名）：IP 与域名须归一到同一实例 ──
  eq(gitlabInstanceAlias("https://gitlab31.dhwaj.cn"), "gitlab31");
  eq(gitlabInstanceAlias("http://192.168.0.31:8080"), "gitlab31");
  eq(gitlabInstanceAlias("HTTPS://GitLab110.dhwaj.cn/"), "gitlab110");
  if (gitlabInstanceAlias("https://gitlab31.dhwaj.cn") === gitlabInstanceAlias("http://192.168.0.110")) {
    throw new Error("self-check 失败: gitlab31 与 gitlab110 不应判为同一实例");
  }

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
  // env 过滤须按分隔符切词全等：hotfix 含 "hot" 不得被 env=hot 误命中（子串陷阱）
  const hotfixJobs: JobInfo[] = [
    { name: "TEST-hot-app", remote: "git@192.168.0.31:fe/app.git", repo: "gitlab31:fe/app", branch: "master" },
    { name: "TEST-qat-hotfix-app", remote: "git@192.168.0.31:fe/app.git", repo: "gitlab31:fe/app", branch: "master" },
  ];
  const hotHits = matchJobs(hotfixJobs, [{ path: "fe/app", key: "gitlab31:fe/app" }], "app", "hot");
  if (hotHits.length !== 1 || hotHits[0].name !== "TEST-hot-app") {
    throw new Error(`self-check 失败: env=hot 误命中 hotfix，实际 ${hotHits.map((j) => j.name).join(",")}`);
  }

  // ── config.xml 写路径：$ 替换陷阱与实体往返（评审实测复现过的 bug）──
  const cfg = "<hudson.plugins.git.BranchSpec>\n  <name>*/master</name>\n</hudson.plugins.git.BranchSpec>";
  for (const nb of ["release$$2024", "feat-$&-x", "a&b"]) {
    const { updated } = setBranchInConfigXml(cfg, nb);
    const readBack = unescapeXml(/<name>([\s\S]*?)<\/name>/.exec(updated)![1]);
    eq(readBack, nb); // 写入什么读回什么，$ 模式与 XML 实体都不得篡改
  }
  // oldBranch 剥前缀 + 反转义
  eq(setBranchInConfigXml(cfg, "x").oldBranch, "master");
  eq(stripBranchPrefix("refs/heads/dev"), "dev");
  eq(stripBranchPrefix("origin/dev"), "dev");
  eq(stripBranchPrefix("dev"), "dev");
  eq(unescapeXml("a&amp;b &#xd; &apos;"), "a&b \r '");
  console.log("self-check ok");
}
