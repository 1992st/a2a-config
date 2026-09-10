# A2A Config 技术设计

## 配置模型

每个工作目录是一个独立 Pi：

```text
workspace
  .pi/settings.json         # 只读项目配置
  .pi/agent/settings.json   # 专属 Pi 和完整 A2A 配置
  .pi/agent/.env.local      # 专属 A2A Token
  .pi/agent/a2a_registry/   # 实际运行端口
  .pi/agent/a2a_runtime/    # 不含密钥的进程加载登记
```

Pi 启动时使用：

```bash
PI_CODING_AGENT_DIR=<workspace>/.pi/agent pi
```

这利用 Pi 源码的 `PI_CODING_AGENT_DIR` 覆盖能力，不需要全局 settings 或 profiles。

## 初始化算法

1. `realpath` 校验工作目录。
2. 读取 `.pi/settings.json` 和 `.pi/agent/settings.json`；任一存在但 JSON 非法时停止，不覆盖。
3. 创建缺失的 `.pi/agent`、`settings.json` 和 `sessions/`。
4. 状态文件只追加工作目录真实路径；服务端串行执行初始化，避免并发添加丢失路径或分配重复 ID/端口。
5. `.pi/agent/settings.json` 已有 `a2a` object 时跳过 A2A 写入。
6. 没有 A2A 时生成：
   - `agentName` 为原始目录名；
   - `instanceId` 为小写 ASCII slug，无法生成时为 `pi-<8位路径哈希>`；
   - ID 冲突时追加 `-<6位路径哈希>`；
   - host `0.0.0.0`、Server 关闭、fallback 10；
   - 唯一 workspace root 为目录真实路径。
7. 从 `9910` 开始跳过受管配置端口、registry 端口和系统占用端口。
8. 插件未配置时执行 `pi install`，进程 cwd 为 workspace，环境覆盖 `PI_CODING_AGENT_DIR`。
9. 安装失败不删除已创建配置；返回重试命令。

插件来源优先级：`--plugin-source`、`A2A_CONFIG_PLUGIN_SOURCE`、当前 monorepo 的 `pi_extensions/zhangst_a2a-pi`。Pi 来源优先级：`A2A_CONFIG_PI`、PATH、常见 npm/bun 路径、npm/pnpm/bun 全局目录。

## 状态存储

```json
{
  "version": 3,
  "workspaces": ["/absolute/workspace"],
  "fileWorkspaces": []
}
```

不迁移旧 `manualAgentDirs`，避免把全局 `~/.pi/agent` 误认为工作目录。

`fileWorkspaces` 是 A2A Config 自有数据，不写入 Pi settings。每项保存稳定 ID、名称、真实根目录、enabled、监听/发布地址、端口、用户名、明文密码、Ed25519 host key 信息和 Agent workspace key 列表。

## 接口

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/state` | 工作目录、有效配置、操作状态、端口状态和配置加载状态 |
| POST | `/api/workspaces/inspect` | 只读检查工作目录 |
| POST | `/api/workspaces` | 启动异步初始化 |
| DELETE | `/api/workspaces/:key` | 只移除工具登记，不删除目录文件 |
| GET | `/api/operations/:id` | 初始化阶段、结果、错误和重试命令 |
| GET | `/api/port-status` | 轻量刷新所有端口和配置加载状态 |
| POST | `/api/ports/check` | 检查单个 host/port |
| GET | `/api/instances/:key` | 读取单实例 |
| POST | `/api/instances/:key/server/enable` | 生成启用预览或要求连接方名称 |
| POST | `/api/connections/validate` | 验证远端 Agent Card 和 Token |
| POST | `/api/config/preview` | 生成 settings/env 差异与基础 hash |
| POST | `/api/config/apply` | 带锁和 hash 检查的原子写入 |
| GET/POST | `/api/file-workspaces` | 列表和创建文件空间 |
| POST | `/api/file-workspaces/inspect` | 检查目录、依赖、地址和端口 |
| PUT | `/api/file-workspaces/:id` | 更新配置并按需重启 |
| POST | `/api/file-workspaces/:id/enable|disable|restart` | 管理 rclone 子进程 |
| PUT | `/api/file-workspaces/:id/agents` | 更新多对多 Agent 绑定 |
| GET | `/api/file-workspaces/status` | 只读刷新运行状态和端口冲突 |
| GET | `/api/agent/file-workspaces?agentId=` | loopback Agent 查询绑定信息 |

页面每 30 秒调用 `/api/port-status` 和 `/api/file-workspaces/status`，只刷新运行状态，不重复安装扫描或写文件。

macOS 运行检测只读取 `ps` 的 PID/命令名和 `lsof` 的 cwd，不读取完整进程环境。插件为所有 host Pi 写入 `a2a_runtime` 心跳；同 cwd 有 Pi 但专属目录没有对应登记时标记为“配置目录未确认”。

## 端口诊断

- 相同 host+port 冲突。
- `0.0.0.0` 与任意 IPv4 host 的相同端口冲突。
- 不同具体网卡地址不直接判冲突。
- registry 实际端口与配置端口不同为 fallback。
- 两个 registry 声明相同实际端口为错误。
- 配置端口无法 bind 且没有受管 Pi 占用时，标记其他程序占用。
- 显式 `publicUrl` 端口与实际端口不同，标记地址不一致。

## 保存一致性

- Preview 保存 settings/env hash，5 分钟失效。
- Apply 按路径排序获取 `.a2a-config.lock` 文件锁。
- hash 变化返回 `CONFIG_CHANGED`，不写文件。
- 使用同目录临时文件和 rename 替换。
- 第二个文件写入失败时恢复两份原内容；原 env 不存在时删除本次新建文件。
- 修改 instanceId 时同步迁移 `PI_A2A_<INSTANCE_ID>`，目标变量已存在时拒绝。
- 同一草稿的新增、重命名和删除 secret 逐项合并，不能互相覆盖。
- Server 启用预览合并当前全部草稿，不能丢失尚未保存的连接修改。

## 测试范围

- 空目录、已有 `.pi`、已有 agent settings、已有 A2A 保留。
- 中文目录、同名目录、稳定端口和端口冲突。
- fallback、实际端口重复、其他进程占用和 public URL 不一致。
- 自动安装成功、失败保留和重试。
- Server 无连接方启用向导和 Token 原子写入。
- 并发添加两个同名工作目录仍保留两条路径并分配不同 ID/端口。
- 同一草稿同时新增和删除连接时，两类 settings/env 修改都保留。
- Preview/apply、外部修改冲突、锁和回滚。
- 桌面、抽屉和手机布局；30 秒刷新不得写文件。

## 文件传输运行模型

- A2A Config 检测 rclone 与 OpenSSH ssh-keygen，不代为安装。
- 每个 enabled 文件空间由独立 worker 管理一个 `rclone serve sftp`；密码通过子进程环境传递。
- host key 在状态目录生成一次并持久化。worker 等端口实际监听后才报告 running，异常后按 1/3/10 秒重试。
- A2A Config 正常退出时停止所有 worker；启动时恢复 enabled 文件空间。
- Agent 查询使用 instanceId，采用信任本机进程模型；未知或重复 instanceId 返回空列表。
- 插件用 `rclone obscure -` 和 0600 临时 config 调用 `lsjson`、`copyto`、`copy`，并固定 host public key；本地和远端路径都做边界校验。
