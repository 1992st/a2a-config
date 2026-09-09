# A2A Config

本地 Pi A2A 配置管理工具。当前版本提供一个 loopback Node 服务和浏览器页面，直接读取和修改 Pi 自己的配置文件。

## 启动

```bash
node src/server.mjs
```

也可以在上级 `pi-tools` 目录执行 `node src/server.mjs`。

启动后打开终端输出的 `http://127.0.0.1:<port>/`。

## 功能

- 检测默认 `~/.pi/agent` 和已登记的 agentDir。
- 读取 `a2a.profiles[cwd]`，展示当前实例和 A2A registry 运行状态。
- 配置 Server、唯一 workspace、远程 Pi 连接和入站连接方。
- 通过差异预览修改 `settings.json` 和 `.env.local`。
- 明文生成连接 prompt，不保存 prompt 副本。
- 连接验证只读取 Agent Card 和不存在的 task，不发送模型任务。

## 边界

- 不安装、启动、reload 或重启 Pi。
- 不执行 Pi 命令，不读取完整进程环境，不缓存 Agent Card。
- 写入前检查文件 hash；文件在预览后变化时拒绝覆盖。

详细产品、UI、API 和检测规则见 `design/`。
