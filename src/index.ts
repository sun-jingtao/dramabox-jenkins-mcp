#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertEnv } from "./env.js";
import { runSelfCheck } from "./self-check.js";
import { registerTools, runFindJob } from "./tools.js";

const server = new McpServer({ name: "dramabox-jenkins-mcp", version: "0.1.0" });
registerTools(server);

if (process.argv.includes("--self-check")) {
  runSelfCheck();
} else if (process.argv[2] === "--find") {
  // 本地调试：node dist/index.js --find <repo> [hot|qat]
  assertEnv();
  console.log(await runFindJob(process.argv[3] ?? "", process.argv[4] as "hot" | "qat" | undefined));
} else {
  assertEnv(); // fail-fast：配置缺失在启动时暴露，而非首次工具调用时
  await server.connect(new StdioServerTransport());
}
