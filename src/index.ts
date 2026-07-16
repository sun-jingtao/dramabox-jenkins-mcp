#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { normalizeRepo, registerTools, repoPath, runFindJob } from "./tools.js";

const server = new McpServer({ name: "dramabox-jenkins-mcp", version: "0.1.0" });
registerTools(server);

if (process.argv.includes("--self-check")) {
  const eq = (a: string, b: string) => {
    if (a !== b) throw new Error(`self-check 失败: ${a} !== ${b}`);
  };
  eq(normalizeRepo("git@gitlab.example.com:fe/dramabox_other.git"), "gitlab.example.com/fe/dramabox_other");
  eq(normalizeRepo("https://gitlab.example.com/fe/dramabox_other.git"), "gitlab.example.com/fe/dramabox_other");
  eq(normalizeRepo("ssh://git@gitlab.example.com:2222/fe/dramabox_other.git/"), "gitlab.example.com/fe/dramabox_other");
  eq(normalizeRepo("HTTP://GitLab.Example.com/FE/App"), "gitlab.example.com/fe/app");
  eq(repoPath("git@192.168.0.31:fe/haiwai_other.git"), repoPath("https://gitlab.example.com/fe/haiwai_other.git"));
  console.log("self-check ok");
} else if (process.argv[2] === "--find") {
  // 本地调试：node dist/index.js --find <repo> [hot|qat]
  console.log(await runFindJob(process.argv[3] ?? "", process.argv[4] as "hot" | "qat" | undefined));
} else {
  await server.connect(new StdioServerTransport());
}
