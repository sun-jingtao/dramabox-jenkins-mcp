// ─── 配置：仅从 MCP 宿主注入的 process.env 读取（mcp.json → env），不读 .env 文件 ─

const REQUIRED = ["GITLAB_URL", "GITLAB_TOKEN", "JENKINS_URL", "JENKINS_USER", "JENKINS_TOKEN"] as const;

/** 启动时 fail-fast：一次性校验全部必需变量，缺失的全列出来（勿在 self-check 等纯函数路径调用） */
export function assertEnv(): void {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`缺少环境变量 ${missing.join("、")}，请在 MCP 客户端配置的 env 中注入（勿写入对话）`);
  }
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(`缺少环境变量 ${key}，请在 MCP 客户端配置的 env 中注入（勿写入对话）`);
  }
  return v;
}

/** URL 专用归一化；凭证和用户名必须始终按原值使用。 */
export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function requireBaseUrl(key: string): string {
  return normalizeBaseUrl(requireEnv(key));
}
