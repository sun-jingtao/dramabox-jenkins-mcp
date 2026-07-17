# dramabox-jenkins-mcp

DramaBox Jenkins HOT/QAT/QAT2 部署助手（MCP Server），支持 Claude Code、Claude Desktop、Cursor 等任意 MCP 客户端。

让 Agent 在对话里完成完整部署闭环：定位 Job → 查分支与合并状态 → 防覆盖检查后改分支并构建 → 记录可查、可回滚。全程不把 Token 贴进对话。

关联需求：[【PRD】Jenkins HOT/QAT 部署助手 MCP](https://www.tapd.cn/tapd_fe/59787500/story/detail/1159787500001022834)

## 快速开始

### 1. 安装依赖并构建

```bash
cd /Users/luoluo/Desktop/my-github/dramabox-jenkins-mcp
npm install
npm run build
```

自检（不连外网、不需要 Token）：

```bash
npm run self-check
```

### 2. 在 MCP 客户端配置里填写凭证

各客户端配置文件位置：

| 客户端 | 配置位置 |
| --- | --- |
| Claude Code | 项目 `.mcp.json`，或 `claude mcp add` 命令 |
| Claude Desktop | 设置 → 开发者 → `claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json`（或项目内 `.cursor/mcp.json`） |

配置内容通用（标准 `mcpServers` 格式）：

```json
{
  "mcpServers": {
    "dramabox-jenkins": {
      "command": "node",
      "args": [
        "/Users/luoluo/Desktop/my-github/dramabox-jenkins-mcp/dist/index.js"
      ],
      "env": {
        "GITLAB_URL": "https://你的-gitlab-域名",
        "GITLAB_TOKEN": "你的 GitLab Personal Access Token",
        "JENKINS_URL": "http://你的-jenkins:8080",
        "JENKINS_USER": "你的 Jenkins 用户名",
        "JENKINS_TOKEN": "你的 Jenkins API Token"
      }
    }
  }
}
```

| 变量 | 说明 |
| --- | --- |
| `GITLAB_URL` | GitLab 根地址；Token 需要至少 `read_api` |
| `GITLAB_TOKEN` | GitLab Personal Access Token（`PRIVATE-TOKEN`） |
| `JENKINS_URL` | Jenkins 根地址，如 `http://192.168.x.x:8080` |
| `JENKINS_USER` | Jenkins 用户名 |
| `JENKINS_TOKEN` | Jenkins API Token（用户设置里生成，不是登录密码） |

> 凭证**只**通过 MCP 配置的 `env` 注入进程，进程内不读取 `.env` 文件；缺失任一变量时 server 启动即报错（fail-fast），不会等到调用时才发现。请勿把 Token 提交到仓库或贴进对话。

团队推广时：每人复制同一段 `mcpServers` 配置，各自换成自己的 Token；后续若发 npm 包，把 `command`/`args` 换成 `npx` 即可，`env` 字段不用改。

### 3. 启用 MCP

1. 保存配置后重启客户端（或刷新 MCP server），确认 `dramabox-jenkins` 已连接：Claude Code 里执行 `/mcp` 查看，Cursor 在 Settings → MCP 看绿点。
2. 若刚改过代码，先 `npm run build`，再重启该 server。
3. 新开对话，让 Agent 调用工具（见下方示例）。

## 使用示例

对话里直接说：

> 帮我把 dramabox_other 的 HOT 环境部署到 sunjt-0716-fix 分支

Agent 会自动串联：`find_job` 定位 → `deploy` 防覆盖检查后改分支构建。当前分支未合并进主干时会先告警，需要你明确同意后才覆盖。其他常用说法：

> dramabox_other 的 QAT 现在部的是什么分支？合并了吗？（→ find_job + get_status）
>
> dramabox_other 的 QAT2 现在部的是什么分支？（→ find_job(env=qat2) + get_status）
>
> 刚才部错了，帮我回滚 TEST-hot-dramabox-other（→ rollback）
>
> 看下今天都部署过什么（→ list_history）

## 已实现工具

| 工具 | 作用 | 写操作 |
| --- | --- | --- |
| `find_job` | 按 GitLab 仓库定位候选 Job，返回 Job 名、当前分支、仓库地址和链接 | 否 |
| `get_status` | Job 当前分支、最近构建、相对主干合并状态、Job 描述里的部署页线索 | 否 |
| `deploy` | 防覆盖检查 → 改 BranchSpec → 触发构建 → 写操作日志 | **是** |
| `list_history` | 查看经本工具执行的分支切换与构建记录（最新在前） | 否 |
| `rollback` | 切回记录中最近一次分支变更前的分支并构建（同样过防覆盖检查）。语义是「撤销最近一次 deploy」，不是无限逐级回退；要回到更早的分支，用 list_history 查到目标后直接 deploy 即可 | **是** |

**deploy / rollback 的防覆盖规则**（PRD 第 4 节）：

- 目标 Job 当前分支已合并进主干 → 直接执行
- 未合并或无法确认（含仓库属于另一 GitLab 实例、token 无权限）→ 中止并告警，需用户明确同意后带 `force=true` 重试
- 分支已删除时只认已合并 MR 记录，不凭「分支不存在」判定已合并；删除分支视为作者已了结该分支，故凭 merged MR 放行（分支仍存在时则以 compare 为准，squash 合并后需 force）
- 目标分支在 GitLab 上不存在 → 直接拒绝（防打错字触发必败构建）

**匹配规则**：Job 与仓库的对应关系取自 Job `config.xml` 里实际 checkout 的仓库地址，归一化（IP↔域名、`.git` 后缀、斜杠、大小写）后与 GitLab 项目路径**全等**比较，与 Job 名称无关，无模糊回退。环境过滤支持 `hot`、`qat`、`qat2`，按 Job 名分隔词精确匹配，QAT 不会混入 QAT2。内网 IP ↔ 域名映射表在 `src/match.ts` 的 `HOST_ALIAS`：`GITLAB_URL` 与 Job remote 若不是字面相同的 host，必须映射到同一别名，否则跨实例守卫会按“无法确认”中止部署；换 IP、域名或实例时需对应修改。表外 host 会在 find_job 返回里以告警形式列出，不会静默漏配。

**操作日志**：deploy / rollback 在修改分支后先向 `~/.dramabox-jenkins-mcp/deploy-log.jsonl` 追加 pending 记录，取得构建号后再追加同 ID 的状态更新；读取时折叠为一条逻辑部署记录（时间、Job、改动前后分支、构建号）。这样 MCP 在 queue 轮询期间退出也不会丢失 rollback 依据；旧格式日志保持兼容。list_history 与 rollback 都以它为数据源。
