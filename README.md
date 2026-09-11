# A2A Config

本地 Pi A2A 配置工具。用户只需添加工作目录，工具会在该目录内创建独立 Pi 配置，不读取或修改全局 `~/.pi/agent/settings.json`。

## 启动

在 `pi-tools/a2a-config` 中执行：

```bash
node src/server.mjs
```

打开终端输出的 `http://127.0.0.1:<port>/`。

可选参数：

```bash
node src/server.mjs --plugin-source /path/to/zhangst_a2a-pi
```

也可设置：

```bash
A2A_CONFIG_PI=/path/to/pi
A2A_CONFIG_PLUGIN_SOURCE=/path/to/zhangst_a2a-pi
```

嵌入其他应用时可设置 URL 前缀；独立运行时保持为空：

```bash
A2A_CONFIG_BASE_PATH=/a2a-config node src/server.mjs
```

## 添加工作目录

工具只要求一个工作目录，并使用以下结构：

```text
<workspace>/.pi/agent/settings.json
<workspace>/.pi/agent/.env.local
<workspace>/.pi/agent/sessions/
```

- `.pi` 是目录；不存在时自动创建。
- `.pi/settings.json` 始终只读；不存在时也不会创建。
- `.pi/agent/settings.json` 没有 A2A 时，按文件夹名称生成 `agentName`、`instanceId`、workspace 和稳定端口。
- 已有 A2A object 时不修改该 object。
- A2A 插件缺失时自动执行专属 `PI_CODING_AGENT_DIR` 下的 `pi install`。
- Server 默认关闭，监听地址预配置为 `0.0.0.0`。

专属 Pi 启动命令会显示在页面中：

```bash
cd <workspace> && PI_CODING_AGENT_DIR=<workspace>/.pi/agent pi
```

## 端口监控

- 新实例从 `9910` 开始分配未配置、未运行且未被其他程序占用的端口。
- 页面每 30 秒刷新配置端口和 registry 实际端口。
- 配置重复、fallback、实际端口重复、非 Pi 进程占用及 `publicUrl` 端口不一致均会显示警告。
- 已有配置端口只提示，不自动修改。

## Pi 运行检测

- 插件会在专属 `.pi/agent/a2a_runtime/` 写入不含密钥的 PID、cwd 和 instanceId 运行登记。
- 页面每 30 秒检查工作目录中的 Pi 进程和运行登记。
- 检测到 Pi 但找不到专属运行登记时，页面提示该进程可能正在读取全局 `~/.pi/agent`。
- “验证远端”只验证远端 URL 和 Token；当前 Pi 是否加载专属配置会单独显示。

## Server 启用

如果已有带 Token 的连接方，点击“启用 Server”直接进入差异预览。如果没有，页面先要求连接方身份名称并自动生成独立 Token，再将连接方、workspace allowlist、Token、`enabled=true` 和当前未保存草稿一次保存。

连接方身份名称用于 Server 区分远端 Pi，同时作为 `inboundPeers`、Token 映射和 workspace `allowedPeers` 的键。远端 Pi 必须使用生成 Prompt 中的同一个身份名称和 Token。

顶部显示工作区整体状态：存在出站 peer、入站连接方或已启用 Server 时显示“已配置连接”；这只表示配置存在，远端在线情况由“验证远端”单独检查。

## 文件传输

顶栏“文件传输”模块管理独立文件空间。每个文件空间选择一个任意现有目录，并可关联多个本地 Agent；同一 Agent 可以关联多个文件空间。

底层使用 `rclone serve sftp`。创建时名称和用户名默认目录名，用户填写并保存明文密码，端口从 `2022` 开始自动选择。创建后立即启动；A2A Config 退出时停止，重新启动时恢复 enabled 文件空间。

工具不会自动安装依赖：

```bash
# macOS
brew install rclone

# Windows
winget install Rclone.Rclone

# Debian/Ubuntu
sudo apt install rclone openssh-client
```

关联 Agent 可通过本机接口查询连接信息；已认证远端 A2A Agent 可调用 `GetFileTransferInfo`。插件提供 `file_transfer_info`、`a2a_file_transfer_info`、`sftp_list`、`sftp_upload` 和 `sftp_download`。

非 loopback 启动管理页面时必须配置管理 Token：

```bash
A2A_CONFIG_ADMIN_TOKEN='replace-me' node src/server.mjs --host 0.0.0.0 --port 8080
```

## 验证

```bash
npm test
```

详细行为见 `design/`。
