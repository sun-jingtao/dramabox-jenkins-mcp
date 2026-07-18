# dramabox-jenkins-mcp

DramaBox Jenkins HOT/QAT/QAT2 部署助手（MCP Server），支持 Claude Code、Claude Desktop、Cursor 等任意 MCP 客户端。

让 Agent 在对话里完成完整部署闭环：定位 Job → 查询 Jenkins 真实构建状态 → 防覆盖检查 → 修改分支并触发构建。全程不把 Token 贴进对话。

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

Agent 会自动串联：`find_job` 定位 → `deploy` 防覆盖检查后改分支并触发构建。切换代码线且最近成功部署版本未进入主干时会先告警，需要你明确同意后才允许 `force`。其他常用说法：

> dramabox_other 的 QAT 当前配置、最近构建和最近成功部署分别是什么？（→ find_job + get_status）
>
> dramabox_other 的 QAT2 最近成功部署的是哪个分支和 commit？（→ find_job(env=qat2) + get_status）

## 已实现工具

| 工具 | 作用 | 写操作 |
| --- | --- | --- |
| `find_job` | 按 GitLab 仓库定位候选 Job，返回 Job 名、Jenkins 当前配置分支、仓库地址和链接 | 否 |
| `get_status` | 当前配置、最近构建尝试、最近严格成功部署、触发来源及主干合并状态 | 否 |
| `deploy` | 并发与防覆盖检查 → 改 BranchSpec → 触发 Jenkins 构建 | **是** |

## 状态口径

- `Jenkins 当前配置分支` 来自 `config.xml` BranchSpec，只表示下一次准备构建什么，不代表服务器正在运行什么。
- `最近构建尝试` 来自 `lastBuild`，可能是 BUILDING、FAILURE、ABORTED 或 SUCCESS。
- `最近一次成功部署` 来自 `lastStableBuild`，客户端还会再次要求 `result === "SUCCESS" && building === false`。
- 实际 commit SHA 和 branch label 来自 Git Plugin `BuildData.lastBuiltRevision`；多 SCM 时必须由 `remoteUrls` 与 Job 仓库精确匹配。
- Jenkins 构建开始时间为 `timestamp`，展示的完成时间使用 `timestamp + duration`，不声称是部署步骤的精确完成时刻。

## deploy 防覆盖规则

1. Job 已在 queue 或 `lastBuild.building === true`：硬拦截，`force` 不能绕过。写配置前会再次检查，以缩小竞态窗口。
2. 最近成功部署的实际分支与目标分支标准化后同名：直接允许重部署，包括个人分支 force-push 后再次部署。
3. 分支名不同或 BuildData branch label 无法唯一确定：通过 GitLab `merge_base(deployedSha, defaultBranch)` 判断实际部署 SHA 是否已进入主干。
4. SHA 已进入主干：允许切换分支；明确未进入或查询结果 unknown：要求用户确认后用 `force=true`。
5. 无 `lastStableBuild`、构建历史轮转、BuildData 无法匹配、跨 GitLab 实例或 token 无权限：均按 unknown 处理，非 force 不修改 Jenkins。
6. 目标分支明确不存在：始终拒绝。存在性请求失败时，非 force 拦截；用户明确确认 `force=true` 后警告并继续，由 Jenkins 最终校验分支。

同分支判断有一项明确接受的边界：分支删除后以同名重建，也会被当作同分支重部署。个人开发分支允许频繁 force-push 后，单靠 Git 历史无法同时区分“正常改写”和“同名重建”。如果 BuildData 返回多个不同的标准化 branch label，工具不会猜测唯一来源，而会进入跨分支检查。

Squash merge 不保留原 deployed SHA，因此 `merge_base` 会判定该 SHA 未进入主干。工具可以根据 branch label 查询已合并 MR 并给出提示，但 MR 只用于辅助人工判断，不能自动放行。

## 仓库与环境匹配

Job 与仓库的对应关系取自 Job `config.xml` 的仓库地址，归一化 IP/域名、`.git` 后缀、斜杠和大小写后，与 GitLab 项目路径全等比较，不按 Job 名模糊猜测。环境过滤支持 `hot`、`qat`、`qat2`，按 Job 名分隔词精确匹配，QAT 不会混入 QAT2。

内网 IP 与域名映射位于 `src/match.ts` 的 `HOST_ALIAS`。`GITLAB_URL` 和 Job remote 必须归一到同一实例，否则跨实例守卫会 fail-closed；换 IP、域名或实例时需要同步维护映射。

## 已删除的旧能力

`list_history`、`rollback` 和本地部署日志已从工具与 CLI 中删除。本地 JSONL 只能记录当前机器经本 MCP 发起的操作，无法覆盖其他用户直接通过 Jenkins 的部署，不能作为多人环境的权威历史。

升级不会自动删除已有的 `~/.dramabox-jenkins-mcp/deploy-log.jsonl`，但程序不再读取它；确认不需要后可由用户自行清理。

## 系统前提与待验证项

- 已确认不存在绕过 Jenkins 的常规手工服务器部署路径。
- 待真实 QAT/HOT 验证：Jenkins `SUCCESS` 必须等价于目标服务器实际部署成功。
- 待真实 QAT/HOT 验证：FAILURE/ABORTED 不得留下服务器部分更新状态。
- 如果上述前提不成立，应由服务器暴露 `/version`、release manifest、commit SHA 或制品 digest，并以运行时信息作为最终权威源。

## 验证

```bash
npm run build
npm run self-check
```

`self-check` 不访问外网，通过注入式 HTTP mock 覆盖 Jenkins BuildData、严格 SUCCESS、GitLab merge_base、同分支重部署、跨分支拦截和并发硬拦截。
