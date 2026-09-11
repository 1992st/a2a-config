# A2A Config

系统 Pi 的 A2A 配置工具。它管理 Pi Agent 配置目录中的 `settings.json`、`.env.local` 和 `a2a.profiles[cwd]`，不安装、复制、启动或升级 `pi-a2a`。

## 启动

```bash
npm ci
node src/server.mjs
```

默认管理 `~/.pi/agent`。测试或自定义环境可设置 `A2A_CONFIG_AGENT_DIR`，嵌入宿主时可设置：

```bash
A2A_CONFIG_BASE_PATH=/a2a-config \
A2A_CONFIG_STATE_FILE=/private/path/state.json \
A2A_CONFIG_PROXY_TOKEN=random-secret \
node src/server.mjs --host 127.0.0.1 --port 0
```

## 配置边界

- 添加工作目录会在系统 `settings.json` 创建 `a2a.profiles[realpath(workspace)]`。
- `<workspace>/.pi/settings.json` 只读，并按 `pi-a2a` 的项目配置白名单参与有效值展示。
- `packages` 和 `extensions` 只用于诊断 `pi-a2a` 是否 configured、available、loaded。
- 旧 `<workspace>/.pi/agent` 配置不会自动覆盖系统配置，只能通过差异预览显式迁移。
- A2A Config 不执行 `pi install`，也不要求插件源码路径。

## 文件传输

文件空间使用系统 `rclone serve sftp`。状态和明文 SFTP 密码保存在权限为 `0600` 的工具私有状态文件中；只有 loopback 上运行的系统 `pi-a2a`，并且其 instanceId 唯一匹配绑定关系时，才能查询正在运行的文件空间连接信息。

`rclone` 和 `ssh-keygen` 不随工具打包，缺失只影响文件传输模块。

## 验证

```bash
npm test
```
