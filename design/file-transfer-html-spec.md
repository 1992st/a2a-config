# 文件传输 HTML 设计规范

## 页面骨架

```html
<header class="app-header">
  <nav class="module-switch" aria-label="功能模块">
    <button type="button">Agent 配置</button>
    <button type="button" aria-current="page">文件传输</button>
  </nav>
</header>
<div class="layout">
  <aside class="sidebar">
    <nav aria-label="文件空间列表"><button type="button">...</button></nav>
  </aside>
  <main>
    <header class="page-header">...</header>
    <section aria-labelledby="file-status-title">...</section>
    <form id="file-workspace-form">
      <section aria-labelledby="directory-title">...</section>
      <section aria-labelledby="agents-title"><fieldset>...</fieldset></section>
      <section aria-labelledby="advanced-title"><details>...</details></section>
    </form>
  </main>
</div>
<dialog id="file-workspace-dialog"><form>...</form></dialog>
```

- 模块、文件空间、Agent 和命令操作必须使用真实 `button`，不可使用可点击 `div`。
- 关联 Agent 使用 checkbox；密码使用 `type=password`，显示按钮必须有动态 `aria-label`。
- 动态状态使用 `output` 或 `role=status`；错误提示不能只靠颜色。
- 创建弹窗关闭后焦点回到“创建文件空间”；Escape 可关闭且不保存。

## 布局尺寸

- 顶栏高 `56px`；模块切换位于品牌右侧，按钮高 `30px`。
- 桌面左栏宽 `280px`；主区 `32px` 水平内边距，最大内容宽度不固定。
- 状态区在标题下 `18px`，区块间使用 `1px #E7EBED` 分隔线，不使用嵌套卡片。
- 控件高 `36px`，图标按钮 `32px`，圆角 `6px`，焦点环 `2px #8FD8C7`。
- Agent 选择桌面两列；小于 `640px` 改为一列。
- 小于 `900px` 左栏变为抽屉；小于 `640px` 页面标题、状态和操作纵向排列。

## 字体与颜色

- 字体：系统 UI 栈；路径、端口、用户名、密码和指纹使用等宽字体。
- 页面标题 `20/28px`，区块标题 `16/24px`，正文与按钮 `14/20px`，辅助文字 `12/18px`。
- 背景 `#F5F7F8`，表面 `#FFFFFF`，正文 `#172126`，次要文字 `#5E6A70`，边框 `#D7DEE1`。
- 主操作 `#176B5B`，hover `#125447`，成功 `#067647`，警告 `#B54708`，危险 `#B42318`。

## 创建流程

1. 初始只显示现有目录字段和“检查目录”。
2. 检查成功后显示目录可写性、rclone/ssh-keygen 状态、默认名称、用户名、密码、Agent checkbox 和折叠高级设置。
3. 密码和至少一个 Agent 未填写时，“创建并启动”不可提交，并显示字段级错误。
4. rclone 缺失时显示平台安装命令和重新检测入口，不自动安装。
5. 目录重复时显示已有文件空间名称，并提供定位到已有项的操作，不允许重复创建。
6. 创建提交期间按钮显示“创建中”并禁止重复提交；成功后关闭弹窗、选中新项并显示“启动中”。

## 详情行为

- 顶部状态显示：未配置、依赖缺失、启动中、运行中、自动重试、已停用、端口冲突、启动失败。
- “停用”只停止进程并保留所有配置；不提供删除按钮。
- 修改名称、对外地址或 Agent 绑定只保存状态；修改监听地址、端口、用户名或密码后自动重启。
- 密码默认遮挡，支持显示/隐藏和复制；复制成功使用 toast，不在日志显示密码。
- 高级设置默认折叠；常规用户无需理解监听地址或端口。

## 必测状态

- 无文件空间、无 Agent、依赖缺失、目录不可写、重复目录、无可发布地址。
- 启动成功、停用、手动重启、自动重试 1/3/10 秒、最终失败、端口被占用。
- 长目录、长 Agent 名称、中文名称和密码、窄屏键盘操作、dialog 焦点循环。
