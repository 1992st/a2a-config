# A2A Config 技术设计

## 运行边界

A2A Config 是系统 Pi 的配置和文件空间管理器。它默认读取 `~/.pi/agent`，不安装、复制、启动或升级 `pi-a2a`，也不修改 Pi 的 `packages` 和 `extensions`。

```text
Browser UI -> loopback HTTP -> system agentDir/settings.json + .env.local
                              -> workspace/.pi/settings.json (read-only)
                              -> rclone workers
```

嵌入模式使用 `A2A_CONFIG_BASE_PATH=/a2a-config` 和宿主代理 Token；独立模式 base path 为空。

## 配置合并

实例以 `{agentDir, realpath(cwd)}` 唯一标识。有效 A2A 配置严格按系统插件顺序计算：

1. 系统 `settings.json.a2a` 全局字段。
2. `settings.json.a2a.profiles[cwd]`。
3. `<cwd>/.pi/settings.json.a2a` 中允许的项目字段。

项目配置不能覆盖 `instanceId`、workspaces、inboundPeers、server 启用状态、监听地址、认证、权限和 discovery gateway。A2A Config 只写系统 profile 和系统 `.env.local`。

新增工作目录创建 `a2a.profiles[realpath(cwd)]`，保留系统配置及其他 profile 的未知字段。插件状态分别报告 configured、available、loaded，缺失只提示，不阻止配置。

## 状态与兼容

状态文件版本 4：

```json
{
  "version": 4,
  "manualAgentDirs": [],
  "legacyWorkspaces": [],
  "migratedLegacyWorkspaces": [],
  "fileWorkspaces": []
}
```

旧版本的 workspace 记录进入 `legacyWorkspaces`。发现 `<workspace>/.pi/agent/settings.json` 时，只展示迁移入口；迁移通过现有 preview/apply 事务写入系统 profile 和对应 secret，原文件不删除。

文件空间绑定同时保存当前 key 与 `{agentDir,cwd}` 语义身份。旧 workspace key 唯一匹配时在读取和下次保存时转换。

## 安全和事务

- 管理 API 只接受有效会话；嵌入模式还要求宿主代理 Token。
- `/api/agent/file-workspaces` 仅允许 loopback，供系统 `pi-a2a` 查询唯一 instanceId 已绑定且正在运行的 SFTP 信息。
- 配置 preview 保存原始 hash，apply 时重新校验，并对 settings 和 `.env.local` 加锁及回滚。
- preview 和操作记录有五分钟 TTL 与 100 条上限。
- 状态目录权限 `0700`，状态和 descriptor 文件权限 `0600`。
- `a2a_config_runtime.json` 包含带 base path 的 loopback URL；存活 owner 不允许被覆盖，退出只删除自己的 descriptor。

## 文件空间

文件空间由 `rclone serve sftp` worker 管理。密码只通过最小化的子进程环境传递，不出现在命令行和日志。`rclone`、`ssh-keygen` 缺失只产生 dependency-missing，不影响 Agent 配置。

配置服务退出时先停止全部 worker，再移除自己拥有的 descriptor。宿主等待 worker 的退出宽限后才强制终止。

## 验证重点

- 系统 profile 创建、未知字段保留、项目白名单合并。
- 不创建 workspace 专属 Agent 目录、不执行 Pi 命令。
- base path 页面资源、API、Cookie 和系统插件文件空间查询。
- preview 并发修改拒绝、旧配置显式迁移。
- descriptor 多进程所有权和 worker 退出。
