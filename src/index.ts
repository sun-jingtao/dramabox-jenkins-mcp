#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { normalizeRepo, registerTools, runFindJob } from "./tools.js";

const server = new McpServer({ name: "dramabox-jenkins-mcp", version: "0.1.0" });
registerTools(server);

if (process.argv.includes("--self-check")) {
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
  console.log("self-check ok");
} else if (process.argv[2] === "--find") {
  // 本地调试：node dist/index.js --find <repo> [hot|qat]
  console.log(await runFindJob(process.argv[3] ?? "", process.argv[4] as "hot" | "qat" | undefined));
} else {
  await server.connect(new StdioServerTransport());
}
