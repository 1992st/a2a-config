# A2A Config 技术设计

## 1. 目标架构

当前实现采用无额外运行时依赖的浏览器页面 + 本地 Node.js 服务；页面结构保持 React 可迁移，但本阶段用原生 HTML/JS 先交付可运行版本：

```text
Browser UI
  -> loopback HTTP API
  -> detection / config merge / validation / filesystem boundary
  -> Pi agentDir/settings.json + .env.local
```

运行入口为 `node src/server.mjs`，HTTP 服务绑定 loopback 随机端口，静态页面位于 `web/index.html`。

### 1.1 进程模型

- CLI 启动 Node 服务，绑定 `127.0.0.1` 的系统分配端口。
- 服务生成 256-bit 随机会话密钥，并仅在一次性 `/session/<token>` 启动 URL 中使用。
- 首次访问后设置 `HttpOnly; SameSite=Strict` 会话 cookie 并重定向到 `/`；一次性 URL 立即失效。
- API 同时检查 loopback socket、Host、Origin 和会话 cookie。
- 服务退出后不保留 session、验证状态、Agent Card 或草稿。

## 2. 核心数据结构

```ts
type AgentDirectorySource = "default" | "manual" | "running" | "installation";
type InstanceScope = "global" | "profile";

interface AgentDirectory {
  key: string;
  path: string;
  realPath: string | null;
  sources: AgentDirectorySource[];
  settingsPath: string;
  envPath: string;
  valid: boolean;
  error?: { code: string; message: string };
  piInstallations: PiInstallation[];
  extension: { installed: boolean; source?: string };
  instances: A2AInstance[];
}

interface PiInstallation {
  executablePath: string;
  realPath: string;
  packageRoot?: string;
  version?: string;
  source: "path" | "npm" | "pnpm" | "bun" | "process";
}

interface A2AInstance {
  key: string;
  scope: InstanceScope;
  agentDir: string;
  profileCwd?: string;
  instanceId?: string;
  agentName?: string;
  workspace?: { id: string; root: string };
  effectiveConfig: Record<string, unknown>;
  sources: Record<string, "global" | "profile" | "legacy" | "default">;
  runtime?: { pid: number; url: string; model?: string; startedAt?: string };
  reloadRequired: boolean;
}

type ConfigPatch =
  | { op: "set"; target: "settings"; path: string[]; value: unknown }
  | { op: "delete"; target: "settings"; path: string[] }
  | { op: "set-secret"; instanceId: string; path: string[]; value: string }
  | { op: "delete-secret"; instanceId: string; path: string[] }
  | { op: "rename-secret"; fromInstanceId: string; toInstanceId: string };

interface ConfigPreview {
  previewId: string;
  baseHashes: { settings: string; env: string | null };
  patches: ConfigPatch[];
  settingsDiff: string;
  envDiff: string;
  valid: boolean;
  errors: Array<{ field?: string; code: string; message: string }>;
}
```

不定义 A2A Config 自有的 agent、connection 或 workspace 数据库模型。页面模型始终从 Pi 配置重新构建。

## 3. 工具状态文件

macOS 保存位置：

```text
~/Library/Application Support/a2a-config/state.json
```

内容固定为：

```json
{
  "version": 1,
  "manualAgentDirs": ["/absolute/real/path"]
}
```

- 不记录实例名、token、运行状态、验证状态或最近 Agent Card。
- 写入前对目录执行 `realpath`；失效的历史路径保留原字符串，供用户重新定位或移除。
- Linux 后续使用 `$XDG_CONFIG_HOME/a2a-config/state.json`，Windows 后续使用 `%APPDATA%\\a2a-config\\state.json`。

## 4. Pi 配置读取

### 4.1 Pi 源码规则

Pi 的默认配置目录来自 `getAgentDir()`：

```text
PI_CODING_AGENT_DIR（存在时）
否则 ~/.pi/agent
```

A2A 插件对选定 cwd 的读取顺序为：

1. `~/.pi/agents/settings.json` 中的 `a2a`（历史来源，只读展示）。
2. `<agentDir>/settings.json` 中的全局 `a2a`。
3. `<agentDir>/settings.json.a2a.profiles[cwd]`。
4. `<cwd>/.pi/settings.json.a2a` 中允许的项目级字段。
5. 运行时 ExtensionContext 覆盖；配置工具无法离线读取，只在运行 registry 状态中标记。

A2A Config 只写第 2、3 层和 `<agentDir>/.env.local`。项目 `.pi/settings.json` 不用于启用 server 或扩大权限。

### 4.2 Profile 与 workspace

- 新实例键为绝对、规范化 cwd。
- 新实例只有一个 workspace，`workspaces.<id>.root` 等于 profile cwd。
- `server.defaultWorkspaceId` 等于该 workspace ID。
- `workspaces.<id>.allowedPeers` 是 workspace 授权的唯一记录。
- `workspaces.<id>.allowedAgents` 固定为 `["coding"]`。
- 读取旧 `server.workspace` 时显示迁移来源，但不自动删除。

### 4.3 UI 管理字段

```text
a2a.profiles[cwd].instanceId
a2a.profiles[cwd].server.enabled
a2a.profiles[cwd].server.host
a2a.profiles[cwd].server.port
a2a.profiles[cwd].server.portFallback
a2a.profiles[cwd].server.agentName
a2a.profiles[cwd].server.publicUrl
a2a.profiles[cwd].server.defaultWorkspaceId
a2a.profiles[cwd].workspaces[id]
a2a.profiles[cwd].peers[name]
a2a.profiles[cwd].inboundPeers[name]
a2a.peers[name]（共享出站连接）
```

`timeoutMs` 仅在用户为单连接设置覆盖时写入。`description` 和 `capabilities` 不缓存。

以下字段不展示、不补默认值、不修改：session、trace、discovery、gateway、mDNS、outbound 运行策略、全局 timeouts、skills 覆盖、并发、执行超时、task 保留、UI transcript、TLS 兼容字段和未知字段。

## 5. Secret 读写

### 5.1 变量名

```text
instanceId: pi-main
变量名: PI_A2A_PI_MAIN
```

规则必须复用插件的 `^[a-z][a-z0-9-]{0,62}$` 校验，并执行大写和 `-` 转 `_`。

### 5.2 允许修改的 secret 路径

```text
server.peerTokens.<inboundConnectionName>
outbound.peers.<remotePiName>.token
```

不创建 `server.sharedToken`。已有 sharedToken、gateway secret 和未知合法字段原样保留。

### 5.3 `.env.local` 更新算法

1. 按 UTF-8 读取全文；文件不存在视为空文件。
2. 逐行定位精确变量名，不执行 shell，不展开变量，不读取其他 secret 值到前端。
3. 目标变量出现多次时拒绝保存，返回 `DUPLICATE_SECRET_VARIABLE`。
4. 去除匹配的成对单引号或双引号，解析 JSON object，执行插件同等的字段校验和 64 KiB 限制。
5. 对目标路径做结构化 set/delete，删除空的 peer 容器，但保留其他 server/outbound/gateway 内容。
6. 写回格式为单行单引号包裹的紧凑 JSON；生成 token 使用 URL-safe 字符，不包含单引号。
7. 保留其他行的字节内容和顺序；目标变量不存在时追加到文件末尾并确保单个结尾换行。
8. 新文件权限设为 `0600`；已有文件保留权限，但若 group/other 可读则预览中显示安全警告。
9. 修改 instanceId 时先检查新变量不存在，再在同一事务中重命名变量并更新 settings。

前端只接收当前实例允许编辑的 secret 子树，不能通过通用文件接口读取完整 `.env.local`。

## 6. 自动检测

### 6.1 检测来源与优先级

1. 默认目录 `~/.pi/agent`。
2. 工具状态文件中的手动目录。
3. 已知 agentDir 的 `a2a_registry/*.json`。
4. PATH 中所有名为 `pi` 的入口，解析符号链接并读取所属 package.json。
5. `npm root -g`、`pnpm root -g`、`bun pm bin -g` 的 Pi 安装入口。
6. macOS `ps` 中运行的 Pi 命令；使用 `lsof -a -p <pid> -d cwd -Fn` 获取 cwd。

结果按 `realpath(agentDir)` 和 `realpath(executable)` 去重，sources 合并。

### 6.2 识别规则

- 可执行入口必须最终指向包名 `@earendil-works/pi-coding-agent`，或 Bun 编译产物能通过 `--version` 和 `--help` 的 Pi 特征检查。
- 不把 executable 当作 agentDir 主键；它只证明 Pi 已安装。
- 不读取 `ps eww`、`/proc/<pid>/environ` 或完整进程环境。
- registry 描述符必须满足文件名 PID、JSON PID、进程存活和 TTL，URL 必须为 HTTP(S)。
- registry 的 cwd 与 profile cwd 相等时标记实例运行中；否则显示“检测到运行实例，但尚无配置 profile”。
- 未启用 A2A 且使用未知自定义 agentDir 的进程只能显示为“配置目录未知”，用户必须手动添加。

### 6.3 插件检测

在合并后的 Pi settings 中检查：

- `packages` 中路径或 package source 指向 `zhangst_a2a-pi`。
- `extensions` 中入口解析到 `zhangst_a2a-pi/index.ts` 或其发布包。

缺失时返回安装建议，不执行命令：

```text
PI_CODING_AGENT_DIR=<agentDir> pi install /Volumes/zhangstExtern/code/pi/pi_extensions/zhangst_a2a-pi
```

## 7. 本地 API

所有写接口都要求会话 cookie、`Origin` 精确匹配和 `Content-Type: application/json`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/agent-dirs` | 完整重新检测并返回目录与实例树 |
| POST | `/api/agent-dirs/validate` | 验证手动目录，不保存 |
| POST | `/api/agent-dirs` | 保存验证后的目录 realpath |
| DELETE | `/api/agent-dirs/:key` | 只删除工具自己的手动路径记录 |
| GET | `/api/instances/:key` | 返回有效配置、字段来源和可编辑 secret 子树 |
| GET | `/api/fs/directories?path=` | 只列现有目录，不返回文件内容 |
| POST | `/api/ports/check` | 检查指定 host/port 当前是否可绑定 |
| POST | `/api/connections/validate` | 读取 Agent Card 并验证 token，不发送任务 |
| POST | `/api/config/preview` | 校验 patch、重新读取文件并生成 diff/hash |
| POST | `/api/config/apply` | 使用 previewId 和 base hash 原子应用 |

### 7.1 Preview 请求

```json
{
  "agentDirKey": "sha256-realpath",
  "instanceKey": "sha256-profile-cwd",
  "patches": []
}
```

服务端不接受任意 JSON Pointer。每种 patch 都必须落在第 4.3 和 5.2 节的 allowlist 内。

### 7.2 Apply 请求

```json
{
  "previewId": "random-one-time-id",
  "baseHashes": {
    "settings": "sha256",
    "env": "sha256-or-null"
  }
}
```

previewId 单次使用、5 分钟过期，并绑定当前 session、agentDir 和 patch 内容。

## 8. 写入一致性

1. Preview 和 apply 都重新读取目标文件。
2. Apply 按规范路径顺序获取 `settings.json`、`.env.local` 锁，避免交叉死锁。
3. 文件 hash 与 preview 不同则返回 `CONFIG_CHANGED`，不写任何文件。
4. 对两份内容完成解析、合并和验证后，分别写同目录临时文件并 `fsync`。
5. 先替换 `.env.local`，再替换 `settings.json`；Pi 仅在 reload 时读取，因此替换间隔不会产生运行时半配置。
6. 第二次替换失败时，用内存中的原内容通过新的临时文件恢复 `.env.local`，并返回明确回滚状态。
7. 临时文件名包含随机值，关闭句柄后 rename；成功或失败都清理本次临时文件。
8. 不创建长期备份，不把 secret 写入日志、错误或状态文件。

settings JSON 使用两空格缩进和结尾换行。未知顶层字段、未知 A2A 字段和未管理数组必须保留。

## 9. 连接验证

验证流程不触发模型：

1. 对 `<base>/.well-known/agent-card.json` 发起 GET，404 时尝试 legacy `agent.json`。
2. 从 card 的 JSONRPC interface 得到实际 endpoint，否则使用配置 URL。
3. 使用 token 调用 `GetTask`，参数为随机不存在的 task ID。
4. A2A `task not found` 表示 endpoint、token、身份和 `task:read` 可用。
5. 401 为 token 错误；403 为身份未登记或权限不足；连接错误和超时分别返回。
6. 验证结果只返回当前请求，不保存。

服务端复用 A2A 插件的 URL 安全策略；用户明确配置的 RFC1918 地址允许连接，但 link-local metadata 地址始终拒绝。

## 10. 配置映射

### 10.1 新建入站连接

普通配置：

```json
{
  "inboundPeers": {
    "research-pi": {
      "scopes": ["message:send", "task:read"],
      "allowedWorkspaces": [],
      "allowedAgents": ["coding"],
      "allowedTools": ["read", "grep", "find", "ls", "write", "edit", "bash"]
    }
  },
  "workspaces": {
    "main": {
      "root": "/code/project",
      "allowedPeers": ["research-pi"],
      "allowedAgents": ["coding"]
    }
  }
}
```

Secret：

```json
{
  "server": {
    "peerTokens": {
      "research-pi": "plain-token"
    }
  }
}
```

### 10.2 新建出站连接

普通配置：

```json
{
  "peers": {
    "build-pi": {
      "url": "http://host:9910/a2a/v1"
    }
  }
}
```

Secret：

```json
{
  "outbound": {
    "peers": {
      "build-pi": {
        "token": "plain-token"
      }
    }
  }
}
```

## 11. `zhangst_a2a-pi` 协议修复

### 11.1 调用链

Pi 出站请求新增：

```json
{
  "metadata": {
    "pi": {
      "callChain": ["pi-a", "pi-b"]
    }
  }
}
```

- 普通主会话首次出站链为 `[currentInstanceId]`。
- server 收到请求后验证数组最多 64 项，每项匹配 Pi instanceId 格式。
- 当前 `instanceId` 已存在时，在创建本地 isolated session 前返回 `TASK_STATE_REJECTED`。
- 接受后追加当前 `instanceId`，并通过 `AsyncLocalStorage` 绑定到该入站任务的异步执行上下文。
- isolated session 中的 `a2a_call` 读取当前链，不使用进程全局可变数组，因此并发任务互不污染。
- 没有 callChain 的旧请求按空链处理。限制 64 是单次调用深度/报文边界，不是会话轮数。
- `maxPingpongTurns` 不再解析或生效，`contextId` 可无限次继续持久化 session。

### 11.2 分层限流

```text
认证失败：30 次/连续 60 秒/IP
新任务：server.rateLimitPerMinute，默认 60 次/连续 60 秒/身份
控制请求：固定 300 次/连续 60 秒/身份
```

- 只有身份验证失败才消耗认证失败额度。
- `SendMessage` 和 streaming send 消耗新任务额度；连接方覆盖值只覆盖此额度。
- Get/List/Cancel/Subscribe 消耗控制请求额度。
- `antiLoopTriggers` 指标继续存在，统计调用链拒绝。

## 12. 测试设计

- 检测：默认、手动、重复、失效、非法 settings、多个 profile、registry stale/dead、未知 agentDir 进程。
- 配置：字段来源、global/profile 合并、未知字段保留、只改单字段、外部 hash 冲突。
- Secret：空文件、引号、重复变量、非法 JSON、64 KiB、rename 冲突、权限和其他行字节保持。
- 连接：card canonical/legacy、401、403、task-not-found 成功、离线仍可保存。
- UI：草稿、无效字段、差异预览、reload 提示、删除原子 patch、响应式和键盘操作。
- 插件：超过 20 次同 context、A→B→A、A→B→C→A、合法长链、非法链、legacy、并发隔离和三类限流边界。
