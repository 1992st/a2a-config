# 用户视角对抗性审查与收敛结果

## 原设计的主要问题

1. 左侧 agentDir、global、多个 profile 加四个页签，首次打开时用户不知道先选什么。
2. “概览 / Server / 连接其他 Pi / 允许其他 Pi 连接”同时出现，把运行参数、身份、连接和权限放在同一层。
3. workspace、scopes、allowedTools、timeout、discovery 等字段解释成本高，用户的实际目标只是让 Pi 能被连接或连接别人。
4. 原型用大量表格和配置行表达状态，主操作“开启 Server”和“生成连接 Prompt”不够突出。
5. 原设计要求完整实现目录浏览、端口探测、Agent Card 验证、原子双文件写入，但没有可运行实现，容易造成“设计完成但用户不能用”。

## 收敛后的主流程

```text
选择 Pi 配置目录
  -> 选择一个工作目录实例
  -> Server：设置名称、地址、端口、workspace，开启服务
  -> 连接：添加远程 Pi 或添加连接方
  -> 生成 Prompt / 保存并提示 /reload
```

页面只保留三个主 tab：

- Server：当前 Pi 是否提供 A2A 服务。
- 连接其他 Pi：本机主动连接远程 Pi。
- 允许其他 Pi 连接：本机登记连接方并生成 prompt。

“概览”不再作为独立配置 tab；实例身份、插件状态和运行状态放在页面标题区。全局配置不作为主要入口，只在自动检测树中出现，且只用于共享出站连接的未来扩展。

## 现在真正实现的功能

- 检测默认 `~/.pi/agent`、手动登记目录、A2A profiles、插件存在状态和运行 registry。
- 检测 PATH、npm/pnpm/bun 全局 Pi 入口，以及 macOS/Linux 可安全读取的 Pi 进程 cwd。
- 读取实例有效配置并在页面展示。
- 编辑 instanceId、Agent 名称、Server host/port/fallback/publicUrl 和唯一 workspace。
- 添加远程出站连接，保存 URL/token。
- 添加入站连接方，保存 token、最小 scopes、coding agent、标准工具和 workspace allowlist。
- 生成明文连接 prompt。
- 通过 settings.json/.env.local 差异预览后原子写入；文件 hash 变化时拒绝覆盖。
- 读取 Agent Card 并验证远程连接，不发送任务。
- 删除工具自己的手动 agentDir 登记。

## 明确不做

- 不把 A2A 协议 scopes、tools、trace、gateway、mDNS、并发和限流变成 UI 表单。
- 不把运行状态或 Agent Card 缓存到 A2A Config 自己的数据文件。
- 不在浏览器中直接读写任意文件，不执行 Pi 安装和重启。

## 验收重点

用户从空页面到生成 prompt 的路径不超过三次主要操作；高级字段不会阻塞 Server 开启；保存错误必须显示文件和原因；任何外部文件变化都不能被静默覆盖。
