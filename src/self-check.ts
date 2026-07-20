// ─── 自检：守护 normalizeRepo 归一化与 matchJobs 匹配规则（每条断言对应一个真实踩过的坑）─
// 纯函数、无需 env；跑法：npm run self-check

import { normalizeBaseUrl, requireBaseUrl, requireEnv } from "./env.js";
import { createGitlabClient, type MergeStatus, type ProjectRef } from "./gitlab.js";
import {
  createJenkinsClient,
  getUniqueRevisionBranch,
  parseBuildRevision,
  parseBuildTrigger,
  setBranchInConfigXml,
  stripBranchPrefix,
  unescapeXml,
  type JenkinsBuildInfo,
  type JobActivity,
  type JobStatus,
} from "./jenkins.js";
import { gitlabInstanceAlias, matchJobs, normalizeRepo, type JobInfo } from "./match.js";
import { runDeploy, runGetStatus, type ToolDependencies } from "./tools.js";

export async function runSelfCheck(): Promise<void> {
  const eq = (a: unknown, b: unknown) => {
    if (a !== b) throw new Error(`self-check 失败: ${a} !== ${b}`);
  };
  // 配置读取保持凭证原值；只有 URL 使用专用尾斜杠归一化。
  const tokenKey = "DRAMABOX_SELF_CHECK_TOKEN";
  const urlKey = "DRAMABOX_SELF_CHECK_URL";
  const previousToken = process.env[tokenKey];
  const previousUrl = process.env[urlKey];
  try {
    process.env[tokenKey] = "token///";
    process.env[urlKey] = "https://example.test///";
    eq(requireEnv(tokenKey), "token///");
    eq(requireBaseUrl(urlKey), "https://example.test");
    eq(normalizeBaseUrl("https://example.test///"), "https://example.test");
  } finally {
    if (previousToken === undefined) delete process.env[tokenKey];
    else process.env[tokenKey] = previousToken;
    if (previousUrl === undefined) delete process.env[urlKey];
    else process.env[urlKey] = previousUrl;
  }
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
    { name: "TEST-qat-app", remote: "git@192.168.0.31:fe/app.git", repo: "gitlab31:fe/app", branch: "master" },
    { name: "TEST-qat2-app", remote: "git@192.168.0.31:fe/app.git", repo: "gitlab31:fe/app", branch: "master" },
    { name: "TEST-qat-hotfix-app", remote: "git@192.168.0.31:fe/app.git", repo: "gitlab31:fe/app", branch: "master" },
  ];
  const appProject = [{ path: "fe/app", key: "gitlab31:fe/app" }];
  const hotHits = matchJobs(hotfixJobs, appProject, "app", "hot");
  if (hotHits.length !== 1 || hotHits[0].name !== "TEST-hot-app") {
    throw new Error(`self-check 失败: env=hot 误命中 hotfix，实际 ${hotHits.map((j) => j.name).join(",")}`);
  }
  const qatHits = matchJobs(hotfixJobs, appProject, "app", "qat");
  if (qatHits.length !== 2 || qatHits.some((job) => job.name.includes("qat2"))) {
    throw new Error(`self-check 失败: env=qat 与 qat2 未隔离，实际 ${qatHits.map((j) => j.name).join(",")}`);
  }
  const qat2Hits = matchJobs(hotfixJobs, appProject, "app", "qat2");
  if (qat2Hits.length !== 1 || qat2Hits[0].name !== "TEST-qat2-app") {
    throw new Error(`self-check 失败: env=qat2 精确过滤，实际 ${qat2Hits.map((j) => j.name).join(",")}`);
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
  eq(stripBranchPrefix("refs/remotes/origin/dev"), "dev");
  eq(stripBranchPrefix("origin/dev"), "dev");
  eq(stripBranchPrefix("dev"), "dev");
  eq(unescapeXml("a&amp;b &#xd; &apos;"), "a&b \r '");

  // ── 构建触发来源：人工用户优先；非人工 cause 保留完整描述，避免「由 Started by...触发」──
  const userTrigger = parseBuildTrigger([
    { shortDescription: "Started by an SCM change" },
    { userName: "admin", shortDescription: "Started by user admin" },
  ]);
  if (userTrigger?.kind !== "user" || userTrigger.label !== "admin") {
    throw new Error("self-check 失败: 人工构建触发者解析");
  }
  const scmTrigger = parseBuildTrigger([{ shortDescription: "Started by an SCM change" }]);
  if (scmTrigger?.kind !== "cause" || scmTrigger.label !== "Started by an SCM change") {
    throw new Error("self-check 失败: 非人工构建 cause 解析");
  }

  // ── Git BuildData: skip unrelated actions and match the Job repository exactly ──
  const buildActions = [
    { _class: "hudson.model.CauseAction", causes: [{ userName: "user1" }] },
    {
      _class: "hudson.plugins.git.util.BuildData",
      remoteUrls: ["git@192.168.0.110:fe/app.git"],
      lastBuiltRevision: { SHA1: "wrong", branch: [{ name: "origin/wrong" }] },
    },
    {
      _class: "hudson.plugins.git.util.BuildData",
      remoteUrls: ["git@192.168.0.31:fe/app.git"],
      scmName: "app",
      lastBuiltRevision: {
        SHA1: "abc123",
        branch: [{ name: "refs/remotes/origin/feature-a" }],
      },
    },
  ];
  const parsedRevision = parseBuildRevision(buildActions, "gitlab31:fe/app");
  eq(parsedRevision?.sha, "abc123");
  eq(getUniqueRevisionBranch(parsedRevision), "feature-a");
  const ambiguousRevision = parseBuildRevision(
    [buildActions[2], { ...buildActions[2], scmName: "duplicate" }],
    "gitlab31:fe/app"
  );
  eq(ambiguousRevision, undefined);
  eq(
    getUniqueRevisionBranch({
      sha: "abc123",
      branches: ["feature-a", "feature-b"],
      remoteUrls: ["git@192.168.0.31:fe/app.git"],
    }),
    null
  );

  // ── Injectable Jenkins HTTP client: activity and strict lastStableBuild are separate ──
  const configXml = [
    "<project>",
    "<description>deploy https://test.example.com/app?a=1&amp;b=2</description>",
    "<hudson.plugins.git.UserRemoteConfig><url>git@192.168.0.31:fe/app.git</url></hudson.plugins.git.UserRemoteConfig>",
    "<hudson.plugins.git.BranchSpec><name>*/feature-b</name></hudson.plugins.git.BranchSpec>",
    "</project>",
  ].join("");
  const rawBuild = (
    number: number,
    result: string,
    branch: string,
    sha: string,
    building = false
  ) => ({
    number,
    result,
    building,
    timestamp: 1_700_000_000_000,
    duration: 12_000,
    url: `https://jenkins.example/job/TEST-hot-app/${number}/`,
    actions: [
      { causes: [{ userName: "user1", shortDescription: "Started by user user1" }] },
      {
        _class: "hudson.plugins.git.util.BuildData",
        remoteUrls: ["git@192.168.0.31:fe/app.git"],
        lastBuiltRevision: { SHA1: sha, branch: [{ name: `origin/${branch}` }] },
      },
    ],
  });
  const jsonResponse = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const jenkinsMock = createJenkinsClient({
    baseUrl: "https://jenkins.example///",
    user: "test",
    token: "token/",
    fetchImpl: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.startsWith("//")) {
        throw new Error("self-check 失败: Jenkins base URL 尾斜杠未正确归一化");
      }
      const authorization = new Headers(init?.headers).get("Authorization") ?? "";
      eq(Buffer.from(authorization.replace(/^Basic /, ""), "base64").toString(), "test:token/");
      if (url.pathname.endsWith("/config.xml")) return new Response(configXml);
      if (url.pathname.endsWith("/lastStableBuild/api/json")) {
        return jsonResponse(rawBuild(40, "SUCCESS", "feature-a", "abc123"));
      }
      if (url.pathname.endsWith("/api/json")) {
        return jsonResponse({
          inQueue: true,
          queueItem: { id: 77, why: "Waiting for next available executor" },
          lastBuild: rawBuild(41, "FAILURE", "feature-b", "def456"),
        });
      }
      return jsonResponse({}, 404);
    },
  });
  const httpStatus = await jenkinsMock.getJobStatus("TEST-hot-app");
  eq(httpStatus.configuredBranch, "feature-b");
  eq(httpStatus.lastBuild?.result, "FAILURE");
  eq(httpStatus.deployedBuild?.number, 40);
  eq(httpStatus.deployedBuild?.revision?.sha, "abc123");
  eq(getUniqueRevisionBranch(httpStatus.deployedBuild?.revision), "feature-a");
  eq(httpStatus.inQueue, true);
  eq(httpStatus.queueId, 77);
  eq(httpStatus.queueReason, "Waiting for next available executor");
  eq(httpStatus.deployUrls[0], "https://test.example.com/app?a=1&b=2");

  const unstableMock = createJenkinsClient({
    baseUrl: "https://jenkins.example",
    user: "test",
    token: "token",
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/config.xml")) return new Response(configXml);
      if (url.pathname.endsWith("/lastStableBuild/api/json")) {
        return jsonResponse(rawBuild(40, "UNSTABLE", "feature-a", "abc123"));
      }
      return jsonResponse({ inQueue: false, lastBuild: null });
    },
  });
  const unstableStatus = await unstableMock.getJobStatus("TEST-hot-app");
  eq(unstableStatus.deployedBuild, null);
  if (!unstableStatus.deployedBuildError?.includes("不是严格 SUCCESS")) {
    throw new Error("self-check 失败: UNSTABLE 不得视为严格成功部署");
  }
  const noStableBuildMock = createJenkinsClient({
    baseUrl: "https://jenkins.example",
    user: "test",
    token: "token",
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/config.xml")) return new Response(configXml);
      if (url.pathname.endsWith("/lastStableBuild/api/json")) return jsonResponse({}, 404);
      return jsonResponse({ inQueue: false, lastBuild: null });
    },
  });
  const noStableBuildStatus = await noStableBuildMock.getJobStatus("TEST-hot-app");
  eq(noStableBuildStatus.deployedBuild, null);
  eq(noStableBuildStatus.deployedBuildError, undefined);

  // ── Injectable GitLab HTTP client: merge_base is a three-state ancestry check ──
  const gitlabMock = createGitlabClient({
    baseUrl: "https://gitlab.example///",
    token: "token/",
    fetchImpl: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.startsWith("//")) {
        throw new Error("self-check 失败: GitLab base URL 尾斜杠未正确归一化");
      }
      eq(new Headers(init?.headers).get("PRIVATE-TOKEN"), "token/");
      const [sha] = url.searchParams.getAll("refs[]");
      if (sha === "missing") return jsonResponse({}, 404);
      if (sha === "server-error") return jsonResponse({}, 500);
      return jsonResponse({ id: sha === "abc123" ? "abc123" : "common-base" });
    },
  });
  const project: ProjectRef = { id: 1, defaultBranch: "master" };
  eq(await gitlabMock.isCommitMergedToDefaultBranch(project, "abc123"), true);
  eq(await gitlabMock.isCommitMergedToDefaultBranch(project, "def456"), false);
  eq(await gitlabMock.isCommitMergedToDefaultBranch(project, "missing"), null);
  eq(await gitlabMock.isCommitMergedToDefaultBranch(project, "server-error"), null);
  const mergeBaseError = await gitlabMock.getCommitMergeStatus(project, "server-error");
  if (mergeBaseError.state !== "unknown" || !mergeBaseError.detail.includes("返回 500")) {
    throw new Error("self-check 失败: merge_base unknown 应保留具体 HTTP 错误");
  }

  // ── deploy orchestration: same branch, cross branch, and hard concurrency blocks ──
  const deployedBuild: JenkinsBuildInfo = {
    number: 40,
    result: "SUCCESS",
    building: false,
    startedAt: 1_700_000_000_000,
    duration: 12_000,
    completedAt: 1_700_000_012_000,
    url: "https://jenkins.example/job/TEST-hot-app/40/",
    revision: {
      sha: "abc123",
      branches: ["feature-a"],
      remoteUrls: ["git@192.168.0.31:fe/app.git"],
    },
  };
  const idleActivity: JobActivity = { inQueue: false, lastBuild: deployedBuild };
  const baseStatus: JobStatus = {
    name: "TEST-hot-app",
    remote: "git@192.168.0.31:fe/app.git",
    repo: "gitlab31:fe/app",
    branch: "feature-a",
    configuredBranch: "feature-a",
    lastBuild: deployedBuild,
    deployedBuild,
    inQueue: false,
    deployUrls: [],
  };
  let mergeCalls = 0;
  let triggerCalls = 0;
  let updateCalls = 0;
  let branchExistsError = false;
  let branchExistsResult = true;
  let mergeState: MergeStatus = { state: "not_merged", detail: "abc123 尚未进入 master" };
  let currentStatus = baseStatus;
  const toolDeps: ToolDependencies = {
    listJenkinsJobs: async () => [],
    getJobStatus: async () => currentStatus,
    getJobActivity: async () => idleActivity,
    updateJobBranch: async () => {
      updateCalls++;
      return "feature-a";
    },
    triggerBuild: async () => {
      triggerCalls++;
      return 42;
    },
    searchGitlabProjects: async () => [],
    getProjectByPath: async () => project,
    branchExists: async () => {
      if (branchExistsError) throw new Error("GitLab branch API 返回 503");
      return branchExistsResult;
    },
    getCommitMergeStatus: async (): Promise<MergeStatus> => {
      mergeCalls++;
      return mergeState;
    },
    gitlabUrl: () => "https://gitlab31.dhwaj.cn",
    jenkinsUrl: () => "https://jenkins.example",
  };
  const sameBranchResult = await runDeploy("TEST-hot-app", "feature-a", false, toolDeps);
  if (!sameBranchResult.includes("已触发")) {
    throw new Error("self-check 失败: 同一成功部署分支应跳过 ancestry 并直接重部署");
  }
  eq(mergeCalls, 0);
  eq(triggerCalls, 1);
  eq(updateCalls, 0);
  const crossBranchResult = await runDeploy("TEST-hot-app", "feature-b", false, toolDeps);
  if (!crossBranchResult.includes("已中止部署")) {
    throw new Error("self-check 失败: 未合并成功版本的跨分支部署应拦截");
  }
  eq(mergeCalls, 1);
  eq(triggerCalls, 1);
  mergeState = { state: "merged", detail: "abc123 已进入 master" };
  const mergedCrossBranchResult = await runDeploy("TEST-hot-app", "feature-b", false, toolDeps);
  if (!mergedCrossBranchResult.includes("已触发")) {
    throw new Error("self-check 失败: 成功部署 SHA 已进入主干时应允许跨分支部署");
  }
  eq(mergeCalls, 2);
  eq(triggerCalls, 2);
  eq(updateCalls, 1);
  currentStatus = {
    ...baseStatus,
    lastBuild: { ...deployedBuild, number: 41, result: "BUILDING", building: true },
  };
  const buildingResult = await runDeploy("TEST-hot-app", "feature-a", true, toolDeps);
  if (!buildingResult.includes("不能通过 force 绕过")) {
    throw new Error("self-check 失败: BUILDING 必须硬拦截 force");
  }
  eq(triggerCalls, 2);
  currentStatus = { ...baseStatus, inQueue: true, queueId: 88, queueReason: "Waiting" };
  const queueResult = await runDeploy("TEST-hot-app", "feature-a", true, toolDeps);
  if (!queueResult.includes("不能通过 force 绕过") || !queueResult.includes("#88")) {
    throw new Error("self-check 失败: inQueue 必须硬拦截 force 并展示 queue id");
  }
  eq(triggerCalls, 2);
  currentStatus = { ...baseStatus, lastBuild: null, deployedBuild: null };
  const noStableStatusText = await runGetStatus("TEST-hot-app", toolDeps);
  if (noStableStatusText.includes("缺少匹配当前仓库的 Git BuildData")) {
    throw new Error("self-check 失败: 无 lastStableBuild 时不得误报 BuildData 缺失");
  }
  const firstDeployBlocked = await runDeploy("TEST-hot-app", "feature-a", false, toolDeps);
  if (!firstDeployBlocked.includes("没有可用的 lastStableBuild")) {
    throw new Error("self-check 失败: 新 Job 首次部署必须 fail-closed");
  }
  const firstDeployForced = await runDeploy("TEST-hot-app", "feature-a", true, toolDeps);
  if (!firstDeployForced.includes("已触发")) {
    throw new Error("self-check 失败: 新 Job 获得明确 force 后应允许首次部署");
  }
  eq(triggerCalls, 3);
  currentStatus = baseStatus;
  branchExistsError = true;
  const branchCheckBlocked = await runDeploy("TEST-hot-app", "feature-a", false, toolDeps);
  if (!branchCheckBlocked.includes("带 force=true 重试")) {
    throw new Error("self-check 失败: branch 查询异常时非 force 必须拦截");
  }
  eq(triggerCalls, 3);
  const branchCheckForced = await runDeploy("TEST-hot-app", "feature-a", true, toolDeps);
  if (!branchCheckForced.includes("由 Jenkins 最终校验分支") || !branchCheckForced.includes("已触发")) {
    throw new Error("self-check 失败: branch 查询异常时 force 应警告后继续");
  }
  eq(triggerCalls, 4);
  branchExistsError = false;
  branchExistsResult = false;
  const missingBranchForced = await runDeploy("TEST-hot-app", "missing", true, toolDeps);
  if (!missingBranchForced.includes("不存在分支 missing")) {
    throw new Error("self-check 失败: 明确不存在的目标分支不能通过 force 绕过");
  }
  eq(triggerCalls, 4);

  console.log("self-check ok");
}
