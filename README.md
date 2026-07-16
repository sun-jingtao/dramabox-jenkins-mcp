# dramabox-jenkins-mcp

DramaBox Jenkins HOT/QAT 部署助手（Cursor MCP）。

让 Agent 在对话里完成：读 Job 当前分支 → 改指定分支 → Build Now，避免每次手动切 Jenkins，也不把 Token 贴进对话。

关联需求：https://www.tapd.cn/tapd_fe/59787500/story/detail/1159787500001022834

## 使用

1. 根目录建 `.env`（已 gitignore）：`GITLAB_URL` / `GITLAB_TOKEN` / `JENKINS_URL` / `JENKINS_USER` / `JENKINS_TOKEN`
2. `npm install && npm run build`
3. Cursor `mcp.json` 中添加：

```json
{
  "mcpServers": {
    "dramabox-jenkins": {
      "command": "node",
      "args": ["<项目绝对路径>/dist/index.js"]
    }
  }
}
```

本地调试：`node dist/index.js --find dramabox_other [hot|qat]`，自检：`npm run self-check`。

已实现工具：`find_job`（按 GitLab 仓库定位 Jenkins 候选 Job，返回 Job 名、当前分支、仓库地址、链接）。
