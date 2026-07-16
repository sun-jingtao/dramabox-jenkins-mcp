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
  build: number | null; // 触发的构建号；null = 已入队但未取到号，或构建触发失败
  op?: "deploy" | "rollback"; // 缺省视为 deploy（兼容旧记录）；rollback 查找目标时跳过自身产生的记录
}

export function appendDeployLog(rec: DeployRecord): void {
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  appendFileSync(LOG_FILE, JSON.stringify(rec) + "\n", { encoding: "utf-8", mode: 0o600 });
}

/** 读取某个 Job 的操作记录，最新在前；job 省略时返回全部。坏行（进程被杀写半行等）跳过并计数。 */
export function readDeployLog(job?: string): { records: DeployRecord[]; corrupt: number } {
  if (!existsSync(LOG_FILE)) return { records: [], corrupt: 0 };
  let corrupt = 0;
  const records = readFileSync(LOG_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as DeployRecord;
      } catch {
        corrupt++;
        return null;
      }
    })
    .filter((r): r is DeployRecord => r !== null && (!job || r.job === job))
    .reverse();
  return { records, corrupt };
}
