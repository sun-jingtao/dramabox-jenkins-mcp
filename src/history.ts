// ─── 部署操作日志：deploy 写入，list_history / rollback 读取 ─────────────────
// JSON Lines 追加写，零依赖零配置；文件在用户主目录下，跨 MCP 重启持久。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".dramabox-jenkins-mcp");
const LOG_FILE = join(LOG_DIR, "deploy-log.jsonl");

export interface DeployRecord {
  time: string; // ISO 时间
  job: string;
  from: string; // 改动前分支
  to: string; // 改动后分支
  build: number | null; // 触发的构建号；null = 已入队但未取到号
}

export function appendDeployLog(rec: DeployRecord): void {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify(rec) + "\n", "utf-8");
}

/** 读取某个 Job 的操作记录，最新在前；job 省略时返回全部 */
export function readDeployLog(job?: string): DeployRecord[] {
  if (!existsSync(LOG_FILE)) return [];
  return readFileSync(LOG_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as DeployRecord)
    .filter((r) => !job || r.job === job)
    .reverse();
}
