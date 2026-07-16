# dramabox-jenkins-mcp

DramaBox Jenkins HOT/QAT 部署助手（Cursor MCP）。

让 Agent 在对话里完成：定位 Job → 读当前分支 →（后续）改分支并 Build，避免每次手动切 Jenkins，也不把 Token 贴进对话。

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

### 2. 在 Cursor MCP 配置里填写凭证

编辑 `~/.cursor/mcp.json`（或项目内 `.cursor/mcp.json`）：

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

> 凭证**只**通过 `mcp.json` 的 `env` 注入进程，进程内不读取 `.env` 文件。请勿把 Token 提交到仓库或贴进对话。

团队推广时：每人复制同一段 `mcpServers` 配置，各自换成自己的 Token；后续若发 npm 包，把 `command`/`args` 换成 `npx` 即可，`env` 字段不用改。

### 3. 启用 MCP

1. 保存 `mcp.json` 后，打开 Cursor → **Settings → MCP**，确认 `dramabox-jenkins` 为已连接（绿点）。
2. 若刚改过代码，先 `npm run build`，再在 MCP 面板刷新 / 重启该 server。
3. 新开对话，让 Agent 调用工具（见下方示例）。

## 使用示例

对话里可以直接说：

> 用 find_job 查一下 dramabox_other 的 HOT Job

或：

> 帮我定位仓库 dramabox_other 在 Jenkins 上的 QAT 部署 Job，看看当前分支是什么

不经过 Cursor、本地 CLI 调试时，需在 shell 里显式注入同样的环境变量：

```bash
export GITLAB_URL=...
export GITLAB_TOKEN=...
export JENKINS_URL=...
export JENKINS_USER=...
export JENKINS_TOKEN=...

node dist/index.js --find dramabox_other
node dist/index.js --find dramabox_other hot
node dist/index.js --find dramabox_other qat
```

成功时会打印候选 Job 名、当前分支、仓库 remote、Job 链接。

## 已实现工具

| 工具 | 作用 |
| --- | --- |
| `find_job` | 按 GitLab 仓库关键词定位 Jenkins HOT/QAT 候选 Job，返回 Job 名、当前分支、仓库地址和链接 |

**参数**

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `repo` | 是 | GitLab 仓库名或关键词，如 `dramabox_other` |
| `env` | 否 | `hot` / `qat`；不传则返回全部候选 |

**处理流程（便于排查）**

1. GitLab `GET /api/v4/projects?search=` 搜仓库
2. Jenkins 扫 Job 列表 + 读各 Job `config.xml`（remote / BranchSpec）
3. 用 `group/repo` 路径匹配（兼容内网 IP vs 域名）
4. 可选按 Job 名过滤 hot / qat，拼成可读文本返回

## 路线图（PRD 未落地）

| 工具 | 作用 |
| --- | --- |
| `get_status` | 当前分支、最近构建、相对 master 合并状态、部署页 |
| `deploy` | 防覆盖检查 → 改 BranchSpec → 触发构建 → 写操作日志 |
| `list_history` | 查看该 Job 分支切换记录 |
| `rollback` | 切回日志中上一次分支并构建 |

## 常见问题

**MCP 显示红点 / 工具不可用**

- 确认 `args` 里是**绝对路径**，且已执行过 `npm run build`（存在 `dist/index.js`）
- 确认 `env` 里五个变量都已填写
- 改完 `tools.ts` 后必须重新 `npm run build`，再重启 MCP

**调用时报「缺少环境变量」**

- 变量写在 `mcp.json` → `env`，不是项目 `.env`（本项目不读 `.env`）
- 改完 `mcp.json` 后需重启对应 MCP server

**`--find` 报 GitLab / Jenkins 状态码错误**

- 先确认 shell 里已 `export` 五个变量
- GitLab Token 是否有 `read_api`，URL 是否可从本机访问
- Jenkins 用户名 + API Token 是否正确（Basic Auth）

**找到 0 个 Job**

- 关键词是否太短 / 写错；先不传 `env` 看全量候选
- 该仓库对应 Job 是否非 Git 源码 Job（无 `config.xml` 里的 git remote 会被跳过）
