# A2A Config 产品与 UI 设计

## 1. 产品边界

A2A Config 是 Pi 的本地配置管理器，不是 A2A 调用客户端，也不负责运行任务。

它只完成以下工作：

1. 检测和登记 Pi 配置目录（`agentDir`）。
2. 识别全局 A2A 配置和 `a2a.profiles[cwd]` 工作目录实例。
3. 配置一个实例的 A2A server 和唯一 workspace。
4. 配置当前 Pi 连接其他 Pi。
5. 配置允许其他 Pi 连接当前 Pi。
6. 生成包含明文连接参数的 prompt。
7. 预览并写入 Pi 自己的 `settings.json` 和 `.env.local`。

不包含以下功能：

- 不发送 A2A 消息，不查看、取消或监控 A2A task。
- 不提供 scopes、agent、tool、trace、session、gateway、mDNS 或运行策略编辑器。
- 不安装、启动、reload 或重启 Pi 和 `zhangst_a2a-pi`。
- 不缓存 Agent Card，不保存生成的 prompt，不复制 A2A 配置到工具自己的数据库。

## 2. 数据归属

| 数据 | 唯一保存位置 | A2A Config 行为 |
| --- | --- | --- |
| 普通 A2A 配置 | `<agentDir>/settings.json` | 结构化读取和字段级合并 |
| token | `<agentDir>/.env.local` 的 `PI_A2A_<INSTANCE_ID>` | 明文读取和目标变量更新 |
| 手动添加的目录 | A2A Config 本地状态文件 | 只保存规范化的 `agentDir` 路径 |
| 自动检测结果 | 不保存 | 每次启动、刷新时重新检测 |
| Agent Card | 不保存 | 用户验证连接时临时读取 |
| 连接 prompt | 不保存 | 从当前配置即时生成 |

自动检测结果、运行状态和验证结果都不是配置事实。页面刷新后重新计算，不写入状态文件。

## 3. 信息结构

### 3.1 左侧实例树

树的层级固定为：

```text
Pi 配置目录
  全局配置
  工作目录实例 A
  工作目录实例 B
```

- 配置目录主键：`realpath(agentDir)`。
- 全局配置表示 `settings.json.a2a` 中除 `profiles` 外的字段。
- 工作目录实例表示 `settings.json.a2a.profiles[absoluteCwd]`。
- 全局配置只允许管理共享的出站 Pi 连接；Server 和允许入站页签为只读不可用。
- 新建 server 时必须新建工作目录实例，不能在全局层创建。

### 3.2 右侧页签

工作目录实例包含四个页签：

| 页签 | 内容 |
| --- | --- |
| 概览 | 实例身份、插件状态、配置来源、运行状态和待 reload 状态 |
| Server | Server 开关、监听参数、唯一 workspace |
| 连接其他 Pi | 当前实例或全局共享的出站连接 |
| 允许其他 Pi 连接 | 入站连接方、token、生成 prompt 和删除 |

全局配置仅显示“概览”和“连接其他 Pi”。URL 路径建议为：

```text
/agent-dirs/:agentDirKey/global/:tab
/agent-dirs/:agentDirKey/profiles/:profileKey/:tab
```

刷新浏览器时恢复当前选择。已删除或失效的路径回退到第一个有效实例。

## 4. 页面布局

### 4.1 桌面（宽度 >= 900px）

- 顶栏：固定高度 `56px`，横跨视口，底部 `1px` 边框。
- 左侧栏：固定宽度 `288px`，位于顶栏下方，独立纵向滚动。
- 主区：`margin-left: 288px`，最小宽度 `0`，背景 `#FFFFFF`。
- 内容容器：最大宽度 `1120px`，左右内边距 `32px`，顶部 `24px`，底部为保存栏预留 `88px`。
- 页面标题行：最小高度 `44px`；标题左侧，运行状态和操作按钮右侧。
- 页签栏：高度 `44px`，紧随标题，底部 `1px` 边框，页签间距 `24px`。
- 表单 section 不使用浮动卡片；section 之间用 `1px #E7EBED` 分隔，垂直间距 `28px`。
- 两列表单使用 `grid-template-columns: repeat(2, minmax(0, 1fr))`，列间距 `24px`，行间距 `20px`。
- 列表使用单层表格或列表行，不嵌套卡片。

### 4.2 平板（640px–899px）

- 顶栏保留 `56px`，显示打开导航的菜单图标。
- 左侧栏成为宽 `304px` 的模态抽屉；打开时覆盖内容，并显示半透明遮罩。
- 主区取消左侧偏移，内容左右内边距 `24px`。
- 表单仍允许两列；任一字段最小宽度不足 `240px` 时自动改为单列。

### 4.3 手机（< 640px）

- 内容左右内边距 `16px`。
- 页面标题和状态分两行，操作按钮不与标题抢占同一行。
- 页签水平滚动，不换行，当前页签始终滚动到可见区域。
- 所有表单改为单列。
- 表格改为带分隔线的纵向列表，每条记录的主要操作放在右上角图标菜单。
- 保存栏固定在视口底部，高度 `64px`；“放弃更改”和“保存更改”各占可用宽度的一半。
- 弹窗宽度为 `calc(100vw - 24px)`，最大高度 `calc(100vh - 24px)`，内容独立滚动。

## 5. 视觉规范

### 5.1 字体

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
  "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
```

代码、路径、URL 和 token：

```css
font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
```

| 元素 | 字号 | 行高 | 字重 |
| --- | --- | --- | --- |
| 页面标题 | 20px | 28px | 600 |
| 区块标题 | 16px | 24px | 600 |
| 正文、输入框、按钮、页签 | 14px | 20px | 400/500 |
| 辅助文字、状态、路径来源 | 12px | 18px | 400/500 |

不得使用负字距；不得按视口宽度缩放字体。

### 5.2 颜色

| 用途 | 色值 |
| --- | --- |
| 应用背景 | `#F5F7F8` |
| 主表面 | `#FFFFFF` |
| 主文字 | `#172126` |
| 次要文字 | `#5E6A70` |
| 禁用文字 | `#929CA1` |
| 常规边框 | `#D7DEE1` |
| 弱分隔线 | `#E7EBED` |
| 主操作 | `#176B5B` |
| 主操作悬停 | `#125447` |
| 主操作按下 | `#0E4339` |
| 焦点环 | `#8FD8C7` |
| 成功 | `#067647` |
| 警告 | `#B54708` |
| 错误/删除 | `#B42318` |
| 选中背景 | `#E8F3F0` |
| 代码背景 | `#F1F4F5` |

状态不能只依赖颜色，必须同时显示文字或图标。

### 5.3 控件

- 输入框、选择框、普通按钮：高度 `36px`，圆角 `6px`。
- 图标按钮：`32px × 32px`，图标 `16px`。
- 主按钮左右内边距 `14px`；文字按钮左右内边距 `12px`。
- 表格行最小高度 `52px`。
- toggle 轨道 `36px × 20px`，圆点 `16px`，点击 label 也可切换。
- 焦点环：控件外 `2px solid #8FD8C7`，间隔 `1px`。
- 危险按钮默认白底红字；只有最终确认删除按钮使用红底白字。
- 使用 Lucide 的 `Menu`、`RefreshCw`、`Plus`、`FolderOpen`、`Copy`、`Trash2`、`MoreHorizontal`、`ChevronRight`、`CheckCircle2`、`AlertTriangle` 图标。
- 只有图标的按钮必须有 `aria-label`、可见 hover tooltip 和键盘 focus tooltip。

## 6. 详细交互

### 6.1 顶栏

- 左侧显示产品名“A2A Config”。不显示营销文案。
- 右侧显示最近刷新时间和刷新按钮。
- 刷新按钮重新读取所有目录、配置和运行状态；存在草稿时先弹窗询问“放弃草稿并刷新”。
- 刷新期间按钮旋转并禁用；失败时保留旧数据并显示页面级错误条。

### 6.2 添加 Pi 配置目录

入口为左侧栏底部“添加配置目录”。点击打开 `dialog`：

1. 文本输入框允许粘贴绝对路径。
2. “选择目录”按钮打开本地服务目录浏览器。
3. “验证目录”检查目录存在、可读、`settings.json` 存在且为 JSON object。
4. 验证成功后显示 Pi 版本、插件是否配置以及识别到的 profile 数量。
5. “添加”只保存规范化 `realpath`；重复路径定位到已有项，不新增。

错误分别显示：路径不存在、不是目录、不可读、缺少 `settings.json`、JSON 无效、已添加。

### 6.3 新建工作目录实例

点击配置目录右侧的 `Plus`：

1. 选择现有工作目录；它同时作为 profile cwd 和唯一 workspace root。
2. workspace ID 按目录 basename 转为小写连字符；重复时追加 `-2`，用户可编辑。
3. `instanceId` 默认等于 workspace ID；同一 agentDir 中重复时追加序号，用户可编辑。
4. `agentName` 默认等于 `instanceId`，用户可编辑。
5. 新建实例默认 server 关闭；端口 `9910`，备用端口数量 `10`，host `127.0.0.1`。
6. 创建动作进入草稿并打开差异预览，不直接写文件。

`instanceId` 必须匹配 `^[a-z][a-z0-9-]{0,62}$`。workspace ID 和连接名称必须匹配 `^[A-Za-z0-9._-]{1,64}$`。

既有实例在“概览”页直接编辑 `instanceId` 和 Agent 名称。修改 `instanceId` 时，差异预览必须同时显示 `.env.local` 变量从旧名称迁移到新名称；新变量已存在时禁止保存。Agent 名称为空时使用 `instanceId`，空值不写入 `server.agentName`。

### 6.4 Server 页

- 第一行是“接受其他 Pi 连接”toggle。默认关闭。
- 开启前必须已有 workspace、至少一个入站连接方和对应 token，否则 toggle 后立即显示缺失项并禁止保存。
- host 为下拉选择：`127.0.0.1`、`0.0.0.0` 和本机活动网卡地址。
- 选择非 loopback 地址时显示警告行，但不增加确认步骤。
- 端口为整数输入，范围 `1–65535`；失焦时执行端口可用性检查。
- 备用端口范围 `0–100`，旁边实时显示尝试区间，例如 `9910–9920`。
- `publicUrl` 默认显示“自动”；用户展开“对外地址”后可填绝对 `http://` 或 `https://` URL。空值不写入配置。
- workspace 区只显示一个目录和 workspace ID；修改路径或 ID会更新 profile 和 workspace 配置的草稿。
- `server.workspace` 只作为旧配置来源展示迁移警告，不提供输入框，不主动删除。

### 6.5 连接其他 Pi

列表列为：名称、URL、范围、验证状态、操作。

- “添加连接”打开表单：名称、URL、明文 token、保存范围和可选超时。
- URL 必须是绝对 `http(s)` URL；末尾 `/` 规范化但不改变路径语义。
- 范围默认“仅当前实例”，可切换“配置目录内共享”。
- 共享连接只在全局 `a2a.peers` 保存名称和 URL；每个 profile 的 token 仍写入各自 `PI_A2A_<INSTANCE_ID>`。
- 超时为空时继承插件默认值；填写时范围 `1–120` 分钟，保存为 `timeoutMs`。
- “验证”读取 Agent Card，再用随机不存在的 task ID 调用 `GetTask`。`task not found` 表示 URL、token、身份和读权限有效。
- 验证失败仍允许保存；状态不持久化，下次进入页面重新验证。
- 在线时临时显示 Agent Card 名称和 skills；离线时不显示缓存值。

### 6.6 允许其他 Pi 连接

列表列为：连接方名称、token、workspace、操作。token 全程明文。

- “添加连接方”要求名称和 token；token 默认生成 32 字节 URL-safe 随机值，也可手动替换。
- 每个 cwd 实例只有一个 workspace，因此不显示 workspace 选择器。
- 工具内部写入：

```json
{
  "scopes": ["message:send", "task:read"],
  "allowedWorkspaces": [],
  "allowedAgents": ["coding"],
  "allowedTools": ["read", "grep", "find", "ls", "write", "edit", "bash"]
}
```

- 唯一目录授权写在 `workspaces.<workspaceId>.allowedPeers`，不在两侧重复保存 workspace 列表。
- 读取旧 `allowedWorkspaces` 时保留原值；只有用户确认迁移时才合并到 workspace 侧并删除旧列表。
- “生成连接 prompt”即时读取当前名称、实际 URL、连接方名称和 token，打开只读 `dialog`。
- “复制”复制完整明文 prompt；成功后按钮短暂变为“已复制”。失败时选中全文，供用户手动复制。
- 删除连接方先显示受影响的普通配置和 token；确认后从 `inboundPeers`、workspace `allowedPeers` 和 `server.peerTokens` 一并删除。

### 6.7 差异预览与保存

- 任意修改只更新页面草稿，标题旁显示“未保存”。
- 固定保存栏包含“放弃更改”和“保存更改”。无草稿时整个保存栏隐藏。
- “保存更改”仅在全部字段有效时启用。
- 点击后打开宽 `720px` 的差异预览，分 `settings.json` 和 `.env.local` 两个页签。
- 差异只展示实际修改；token 按用户要求明文显示。
- “确认保存”触发带基础 hash 的 apply；hash 冲突时不覆盖，关闭确认按钮并要求重新读取。
- 成功后清空草稿。运行中的实例显示“已保存，请在该 Pi 执行 /reload”；未运行实例显示“下次启动生效”。
- 任一文件写入失败时显示失败文件和回滚结果，不宣称保存成功。

## 7. 状态与错误

| 状态 | 表现 |
| --- | --- |
| 正在运行 | 绿色圆点 + “运行中”，可显示 PID 和实际 A2A URL |
| 未运行 | 灰色圆点 + “未运行” |
| 等待 reload | 橙色图标 + “配置已保存，等待 /reload” |
| 插件缺失 | 警告条 + 只读安装命令；禁止保存 A2A 表单 |
| 配置无效 | 红色状态 + 原文件路径和 JSON 解析错误；禁止编辑覆盖 |
| 路径失效 | 左侧保留项目并标红，提供“重新定位”和“移除记录” |
| 外部文件变化 | 保留草稿，展示新旧 hash，要求刷新后重新应用 |
| 远端离线 | 出站连接显示“未验证”，不阻止保存 |

删除、覆盖冲突和放弃草稿使用模态确认。普通导航、页签切换和复制不使用确认弹窗。

## 8. 连接 Prompt 规范

```text
请为当前 Pi 配置一个 A2A client 连接，只修改当前 Pi 的配置文件。

远程 Pi 名称：<serverAgentName>
A2A URL：<resolvedA2aUrl>
当前 Pi 在远程 server 上的身份：<inboundConnectionName>
连接 token：<plainToken>
插件路径：/Volumes/zhangstExtern/code/pi/pi_extensions/zhangst_a2a-pi

请完成：
1. 确认当前 Pi 的 agentDir 和当前工作目录对应的 a2a profile。
2. 将名称和 URL 合并到 settings.json 的 a2a.peers，不覆盖其他配置。
3. 将 token 合并到 .env.local 当前 instanceId 对应的
   PI_A2A_<INSTANCE_ID>.outbound.peers，不覆盖其他 secret。
4. 如果插件未安装，只报告建议的 pi install 命令，不自动安装。
5. 保存后提示用户执行 /reload；不要发送测试任务。
6. 报告修改的文件和配置项。
```

## 9. HTML 规范

页面必须使用以下语义层级：

```html
<div id="a2a-config-app">
  <header>...</header>
  <div class="app-layout">
    <aside>
      <nav aria-label="Pi 配置目录">...</nav>
    </aside>
    <main>
      <header>...</header>
      <nav aria-label="实例配置">...</nav>
      <section aria-labelledby="...">
        <form>
          <fieldset>...</fieldset>
        </form>
      </section>
    </main>
  </div>
  <div role="status" aria-live="polite">...</div>
  <dialog>...</dialog>
</div>
```

- 所有 label 使用 `for` 关联输入框；错误文字通过 `aria-describedby` 关联。
- 页签使用 `role="tablist"`、`role="tab"`、`role="tabpanel"` 和方向键切换。
- 实例树使用原生 button 列表；不模拟复杂 ARIA tree 键盘模型。
- 弹窗使用原生 `dialog`，打开后聚焦标题后的第一个字段，关闭后焦点回到触发按钮。
- 删除图标按钮必须有目标名称，例如 `aria-label="删除连接方 research-pi"`。
- 异步刷新、验证、复制和保存结果通过 `role="status"` 宣告；错误用 `role="alert"`。
- `pre` 中的 token 和 prompt 允许横向滚动，但页面主体不得横向溢出。
- Tab 顺序必须与视觉顺序一致；Esc 关闭最上层弹窗，不能直接丢弃有修改的表单。

## 10. 原型验收

- 键盘可完成实例切换、页签切换、打开/关闭弹窗、编辑、预览差异和复制 prompt。
- `390px` 宽度下标题、路径、token 和按钮不重叠；长内容换行或在指定容器内滚动。
- `1024px` 和 `1440px` 下侧栏宽度固定，主区不出现无意义大卡片或空白英雄区。
- Server toggle、添加目录、添加出站连接、添加入站连接、生成 prompt、删除和保存预览都有可见状态变化。
- 原型只使用虚构数据，不读取真实配置，不发送网络请求。
