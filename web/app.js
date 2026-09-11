const state = {
  module: "agents",
  workspaces: [],
  fileWorkspaces: [],
  selectedFileId: null,
  fileDependencies: null,
  fileInspection: null,
  selectedKey: null,
  tab: "server",
  draft: null,
  previewId: null,
  inspection: null,
  connectionMode: null,
  editingConnection: null,
  deleteConnection: null,
  enableToken: null,
};

const $ = (selector) => document.querySelector(selector);
const BASE_PATH = document.querySelector('meta[name="a2a-config-base-path"]')?.content || "";
const apiPath = (path) => `${BASE_PATH}${path}`;
const refreshIcons = () => window.lucide?.createIcons({ attrs: { width: 16, height: 16, "stroke-width": 2 } });
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

async function api(path, options = {}) {
  const response = await fetch(apiPath(path), {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || "请求失败");
  return body;
}

let toastTimer;
function notify(message) {
  clearTimeout(toastTimer);
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function selectedWorkspace() {
  return state.workspaces.find((workspace) => workspace.key === state.selectedKey);
}

function selectedFileWorkspace() {
  return state.fileWorkspaces.find((workspace) => workspace.id === state.selectedFileId);
}

function fileStatusLabel(status) {
  return {
    starting: "启动中", running: "运行中", retrying: "自动重试",
    failed: "启动失败", stopped: "已停用", "dependency-missing": "rclone 未安装", "port-conflict": "端口冲突",
  }[status?.state] || "已停用";
}

function hasConfiguredConnection(workspace) {
  return workspace.server.enabled || workspace.peers.length > 0 || workspace.inbound.length > 0;
}

function connectionStatus(workspace) {
  if (workspace.operation?.status === "running") return { title: "正在写入系统 Pi 配置", detail: `正在执行：${workspace.operation.stage}` };
  if (!hasConfiguredConnection(workspace)) return { title: "尚未配置连接", detail: "未连接其他 Pi，Server 尚未启用" };
  const details = [];
  if (workspace.peers.length) details.push(`已配置其他 Pi ${workspace.peers.length} 个`);
  if (workspace.server.enabled) {
    details.push(workspace.actualPort ? `Server 运行于端口 ${workspace.actualPort}` : "Server 已启用，等待 Pi 启动");
  } else if (workspace.inbound.length) {
    details.push(`允许 ${workspace.inbound.length} 个连接方，Server 当前关闭`);
  }
  return { title: "已配置连接", detail: details.join(" · ") };
}

function conflictMessage(conflict) {
  if (conflict.type === "configured-port-duplicate") return `配置端口 ${conflict.port} 与 ${conflict.otherName} 重复`;
  if (conflict.type === "actual-port-duplicate") return `实际端口 ${conflict.port} 被 ${conflict.otherName} 同时声明`;
  if (conflict.type === "fallback-port") return `配置端口 ${conflict.configuredPort} 已回退到 ${conflict.actualPort}，重启后地址可能改变`;
  if (conflict.type === "public-url-port-mismatch") return `对外地址端口 ${conflict.publicPort} 与实际端口 ${conflict.actualPort} 不一致`;
  if (conflict.type === "occupied-by-other-process") return `端口 ${conflict.port} 已被其他程序占用`;
  if (conflict.type === "missing-public-url") return "监听所有网卡时需要填写其他电脑可访问的对外地址";
  return "端口状态异常";
}

function runtimeMessage(runtimeStatus) {
  const loaded = runtimeStatus?.loadedPids || [];
  const unconfirmed = runtimeStatus?.unconfirmedPids || [];
  if (loaded.length && unconfirmed.length) return `PID ${loaded.join("、")} 已加载系统 A2A 配置；PID ${unconfirmed.join("、")} 尚未确认加载插件。`;
  if (loaded.length) return `当前 Pi 已加载系统 A2A 配置（PID ${loaded.join("、")}）`;
  if (unconfirmed.length) return `检测到 Pi 正在此工作目录运行（PID ${unconfirmed.join("、")}），但尚未确认加载 A2A 插件。`;
  return "";
}

function renderWorkspaceList() {
  const list = $("#workspace-list");
  if (state.workspaces.length === 0) {
    list.innerHTML = '<div class="empty">还没有工作目录</div>';
    return;
  }
  list.innerHTML = state.workspaces.map((workspace) => {
    const status = workspace.portStatus;
    const error = status?.severity === "error" || workspace.error;
    const warning = status?.severity === "warning" || workspace.runtimeStatus?.status === "unconfirmed";
    const title = workspace.error || [...(status?.conflicts || []).map(conflictMessage), runtimeMessage(workspace.runtimeStatus)].filter(Boolean).join("；");
    return `<button class="workspace-item ${workspace.key === state.selectedKey ? "active" : ""}" type="button" data-workspace="${workspace.key}">
      <span class="dot ${hasConfiguredConnection(workspace) ? "running" : ""}"></span>
      <span><span class="workspace-name">${escapeHtml(workspace.agentName || workspace.instanceId || "配置异常")}</span><span class="workspace-path">${escapeHtml(workspace.workspace)}</span></span>
      ${error ? `<span class="error-icon" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">!</span>` : warning ? `<span class="warning-icon" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">!</span>` : ""}
    </button>`;
  }).join("");
  list.querySelectorAll("[data-workspace]").forEach((button) => button.addEventListener("click", () => {
    state.selectedKey = button.dataset.workspace;
    state.draft = null;
    state.tab = "server";
    closeNavigation();
    render();
  }));
}

function renderFileWorkspaceList() {
  const list = $("#workspace-list");
  if (!state.fileWorkspaces.length) {
    list.innerHTML = '<div class="empty">还没有文件空间</div>';
    return;
  }
  list.innerHTML = state.fileWorkspaces.map((workspace) => {
    const failed = workspace.status?.state === "failed" || workspace.status?.state === "dependency-missing";
    const warning = workspace.status?.state === "retrying";
    return `<button class="workspace-item ${workspace.id === state.selectedFileId ? "active" : ""}" type="button" data-file-workspace="${workspace.id}">
      <span class="dot ${workspace.status?.state === "running" ? "running" : ""}"></span>
      <span><span class="workspace-name">${escapeHtml(workspace.name)}</span><span class="workspace-path">${escapeHtml(workspace.root)}</span></span>
      ${failed ? `<span class="error-icon" title="${escapeHtml(workspace.status.error || fileStatusLabel(workspace.status))}">!</span>` : warning ? '<span class="warning-icon" title="正在自动重试">!</span>' : ""}
    </button>`;
  }).join("");
  list.querySelectorAll("[data-file-workspace]").forEach((button) => button.addEventListener("click", () => {
    state.selectedFileId = button.dataset.fileWorkspace;
    closeNavigation();
    render();
  }));
}

function agentOptions(selectedKeys) {
  if (!state.workspaces.length) return '<div class="empty compact">请先在 Agent 配置中添加工作目录。</div>';
  return state.workspaces.filter((agent) => !agent.error).map((agent) => `<label class="check-row"><input type="checkbox" value="${agent.key}" ${selectedKeys.includes(agent.key) ? "checked" : ""}><span><strong>${escapeHtml(agent.agentName)}</strong><small>${escapeHtml(agent.workspace)}</small></span></label>`).join("");
}

function fileWorkspaceView(workspace) {
  const status = workspace.status || {};
  const running = status.state === "running";
  return `<header class="page-header"><div><h1>${escapeHtml(workspace.name)}</h1><p class="path">${escapeHtml(workspace.root)}</p></div><div class="page-actions"><button class="button" id="file-restart" type="button" ${workspace.enabled ? "" : "disabled"}><i data-lucide="rotate-cw"></i><span>重新启动</span></button><button class="button ${workspace.enabled ? "danger" : "primary"}" id="file-toggle" type="button"><i data-lucide="${workspace.enabled ? "square" : "play"}"></i><span>${workspace.enabled ? "停用" : "启用"}</span></button></div></header>
    <section class="status-panel ${running ? "running" : status.state === "failed" ? "error" : status.state === "retrying" ? "warning" : ""}" role="status" aria-live="polite"><div><strong class="status-title">${escapeHtml(fileStatusLabel(status))}</strong><p class="status-detail">${escapeHtml(workspace.publicUrl)}${status.pid ? ` · PID ${status.pid}` : ""}</p></div></section>
    ${status.error ? `<div class="notice error">${escapeHtml(status.error)}</div>` : ""}
    ${!state.fileDependencies?.ready ? `<div class="notice error">缺少文件传输依赖。安装后点击刷新。<pre>${escapeHtml(state.fileDependencies?.install || "请安装 rclone")}</pre></div>` : ""}
    <form id="file-workspace-form" autocomplete="off">
      <section class="section"><div class="section-header"><div><h2>目录</h2><p class="section-description">该目录是 SFTP 根目录。</p></div></div><div class="form-grid"><div class="field"><label for="edit-file-name">文件空间名称</label><input class="control" id="edit-file-name" maxlength="80" value="${escapeHtml(workspace.name)}"></div><div class="field"><label>Host key 指纹</label><output class="control output-control mono">${escapeHtml(workspace.fingerprint)}</output></div><div class="field full"><label>根目录</label><output class="control output-control mono">${escapeHtml(workspace.root)}</output></div></div></section>
      <section class="section"><div class="section-header"><div><h2>关联 Agent</h2><p class="section-description">已关联 Agent 可以查询并使用该文件空间。</p></div></div><fieldset class="agent-fieldset"><legend class="sr-only">关联 Agent</legend><div class="agent-options" id="edit-file-agents">${agentOptions(workspace.boundAgentKeys)}</div></fieldset></section>
      <section class="section"><details><summary>高级设置</summary><div class="form-grid advanced-fields"><div class="field"><label for="edit-file-listen-host">监听地址</label><input class="control mono" id="edit-file-listen-host" value="${escapeHtml(workspace.listenHost)}"></div><div class="field"><label for="edit-file-port">端口</label><input class="control mono" id="edit-file-port" type="number" min="1" max="65535" value="${workspace.port}"></div><div class="field full"><label for="edit-file-public-url">对外地址</label><input class="control mono" id="edit-file-public-url" value="${escapeHtml(workspace.publicUrl)}"></div><div class="field"><label for="edit-file-username">SFTP 用户名</label><input class="control mono" id="edit-file-username" value="${escapeHtml(workspace.username)}" autocomplete="off"></div><div class="field"><label for="edit-file-password">SFTP 密码</label><div class="input-action"><input class="control mono" id="edit-file-password" type="password" maxlength="1024" value="${escapeHtml(workspace.password)}" autocomplete="new-password"><button class="icon-button password-toggle" type="button" aria-label="显示密码" title="显示密码"><i data-lucide="eye"></i></button><button class="icon-button" id="copy-file-password" type="button" aria-label="复制密码" title="复制密码"><i data-lucide="copy"></i></button></div></div></div></details></section>
      <div class="inline-save"><button class="button primary" type="submit">保存文件空间</button></div>
    </form>`;
}

function effectiveDraft(workspace) {
  return {
    instanceId: state.draft?.instanceId ?? workspace.instanceId,
    server: { ...workspace.server, ...(state.draft?.server || {}) },
    workspaceConfig: { ...workspace.workspaceConfig, ...(state.draft?.workspaceConfig || {}) },
  };
}

function serverView(workspace) {
  const draft = effectiveDraft(workspace);
  return `<section class="section">
    <div class="section-header"><div><h2>Server 配置</h2><p class="section-description">状态和端口冲突优先显示；其余参数按需调整。</p></div></div>
    ${workspace.projectSettings.hasA2a ? '<div class="notice">检测到 .pi/settings.json 中已有 A2A 配置；该文件保持不变。</div>' : ""}
    ${!workspace.plugin.configured ? '<div class="notice">系统 Pi 尚未配置 pi-a2a；仍可保存配置，安装扩展后即可生效。</div>' : !workspace.plugin.available ? '<div class="notice error">系统 Pi 已配置 pi-a2a，但插件来源当前不可用。</div>' : ""}
    <form id="server-form" class="form-grid">
      <div class="field"><label for="instance-id">instanceId</label><input class="control mono" id="instance-id" value="${escapeHtml(draft.instanceId)}"></div>
      <div class="field"><label for="agent-name">Agent 名称</label><input class="control" id="agent-name" value="${escapeHtml(draft.server.agentName || workspace.agentName)}"></div>
      <div class="field"><label for="server-host">监听地址</label><select class="control mono" id="server-host"><option ${draft.server.host === "0.0.0.0" ? "selected" : ""}>0.0.0.0</option><option ${draft.server.host === "127.0.0.1" ? "selected" : ""}>127.0.0.1</option></select></div>
      <div class="field"><label for="server-port">端口</label><input class="control mono" id="server-port" type="number" min="1" max="65535" value="${draft.server.port}"><p class="field-help" id="draft-port-status"></p></div>
      <div class="field"><label for="port-fallback">备用端口数量</label><input class="control mono" id="port-fallback" type="number" min="0" max="100" value="${draft.server.portFallback}"></div>
      <div class="field"><label for="public-url">对外地址（可选）</label><input class="control mono" id="public-url" value="${escapeHtml(draft.server.publicUrl)}" placeholder="自动"></div>
      <div class="field full"><label for="workspace-id">Workspace ID</label><input class="control mono" id="workspace-id" value="${escapeHtml(draft.workspaceConfig.id)}"><p class="field-help">目录固定为 ${escapeHtml(workspace.workspace)}</p></div>
    </form>
  </section>`;
}

function outgoingView(workspace) {
  const additions = (state.draft?.outgoing || []).map((entry) => ({ ...entry, pending: true, persisted: Boolean(entry.originalName) }));
  const replaced = new Set(additions.map((entry) => entry.originalName || entry.name));
  const removed = new Set([...(state.draft?.removeOutgoing || []), ...replaced]);
  const rows = [...workspace.peers.filter((entry) => !removed.has(entry.name)).map((entry) => ({ ...entry, persisted: true })), ...additions];
  return `<section class="section"><div class="section-header"><div><h2>连接其他 Pi</h2><p class="section-description">保存远程地址和 Token，不发送测试任务。</p></div><button class="button primary" id="add-outgoing" type="button">添加连接</button></div>
    ${rows.length ? rows.map((entry) => `<div class="connection-row"><div class="connection-main"><strong>${escapeHtml(entry.name)}${entry.pending ? " · 未保存" : ""}</strong><small>${escapeHtml(entry.url)}</small><small>Token：${escapeHtml(entry.token || "未配置")}</small>${entry.timeoutMs ? `<small>超时：${entry.timeoutMs} ms</small>` : ""}</div><div class="connection-actions"><button class="button" data-validate="${escapeHtml(entry.name)}" type="button">验证远端</button><button class="button" data-edit-outgoing="${escapeHtml(entry.name)}" type="button">编辑</button><button class="button danger" data-remove-outgoing="${escapeHtml(entry.name)}" type="button">删除</button></div></div>`).join("") : '<div class="empty">还没有远程 Pi 连接。</div>'}
  </section>`;
}

function incomingView(workspace) {
  const additions = (state.draft?.incoming || []).map((entry) => ({ ...entry, pending: true }));
  const removed = new Set(state.draft?.removeIncoming || []);
  const rows = [...workspace.inbound.filter((entry) => !removed.has(entry.name)), ...additions];
  return `<section class="section"><div class="section-header"><div><h2>允许其他 Pi 连接</h2><p class="section-description">身份名称用于识别远程 Pi，每个身份使用独立 Token。</p></div><button class="button primary" id="add-incoming" type="button">添加连接方</button></div>
    ${rows.length ? rows.map((entry) => `<div class="connection-row"><div class="connection-main"><strong>${escapeHtml(entry.name)}${entry.pending ? " · 未保存" : ""}</strong><small>Token：${escapeHtml(entry.token || "未配置")}</small><small>Workspace：${escapeHtml(workspace.workspaceConfig.id)}</small></div><div class="connection-actions"><button class="button" data-prompt="${escapeHtml(entry.name)}" type="button">生成 Prompt</button><button class="button danger" data-remove-incoming="${escapeHtml(entry.name)}" type="button">删除</button></div></div>`).join("") : '<div class="empty">还没有连接方。</div>'}
  </section>`;
}

function render() {
  $("#module-agents").classList.toggle("active", state.module === "agents");
  $("#module-files").classList.toggle("active", state.module === "files");
  $("#add-workspace").classList.toggle("hidden", state.module !== "agents");
  $("#add-file-workspace").classList.toggle("hidden", state.module !== "files");
  $("#open-nav").setAttribute("aria-label", state.module === "agents" ? "打开工作目录列表" : "打开文件空间列表");
  $(".sidebar-title").textContent = state.module === "agents" ? "工作目录" : "文件空间";
  $("#workspace-list").setAttribute("aria-label", state.module === "agents" ? "已管理工作目录" : "文件空间列表");
  if (state.module === "files") {
    renderFileWorkspaceList();
    $("#save-bar").classList.remove("show");
    const content = $("#main-content");
    const workspace = selectedFileWorkspace();
    content.innerHTML = workspace
      ? fileWorkspaceView(workspace)
      : '<div class="empty"><h1>创建第一个文件空间</h1><p>选择一个现有目录并关联本地 Agent。</p><button class="button primary" id="empty-add-file" type="button">创建文件空间</button></div>';
    $("#empty-add-file")?.addEventListener("click", openFileWorkspaceDialog);
    if (workspace) bindFileWorkspaceEvents(workspace);
    refreshIcons();
    return;
  }
  renderWorkspaceList();
  const workspace = selectedWorkspace();
  const content = $("#main-content");
  $("#save-bar").classList.toggle("show", Boolean(state.draft));
  if (!workspace) {
    content.innerHTML = '<div class="empty"><h1>添加第一个工作目录</h1><p>只需要提供目录路径，Pi 和 A2A 配置会自动完成。</p><button class="button primary" id="empty-add" type="button">添加工作目录</button></div>';
    $("#empty-add")?.addEventListener("click", openWorkspaceDialog);
    return;
  }
  if (workspace.error) {
    content.innerHTML = `<div class="page-header"><div><h1>配置读取失败</h1><p class="path">${escapeHtml(workspace.workspace)}</p></div></div><div class="notice error">${escapeHtml(workspace.error)}</div>`;
    return;
  }
  const portStatus = workspace.portStatus;
  const severity = portStatus?.severity || "none";
  const conflicts = portStatus?.conflicts || [];
  const runtimeStatus = workspace.runtimeStatus;
  const panelSeverity = severity === "none" && runtimeStatus?.status === "unconfirmed" ? "warning" : severity;
  const runtime = runtimeMessage(runtimeStatus);
  const connection = connectionStatus(workspace);
  content.innerHTML = `<header class="page-header"><div><h1>${escapeHtml(workspace.agentName)}</h1><p class="path">${escapeHtml(workspace.workspace)}</p></div><button class="button" id="copy-start" type="button">复制启动命令</button></header>
    <section class="status-panel ${panelSeverity === "none" && hasConfiguredConnection(workspace) ? "running" : panelSeverity}"><div><strong class="status-title">${escapeHtml(connection.title)}</strong><p class="status-detail">${escapeHtml(connection.detail)}</p></div><button class="button ${workspace.server.enabled ? "" : "primary"}" id="server-action" type="button">${workspace.server.enabled ? "关闭 Server" : "启用 Server"}</button></section>
    ${workspace.legacyA2aExists ? `<div class="notice">检测到旧专属 A2A 配置：${escapeHtml(workspace.legacySettingsPath)}。<button class="button" id="preview-legacy-migration" type="button">预览迁移到系统 Pi</button></div>` : ""}
    ${runtime ? `<div class="notice ${runtimeStatus.status === "loaded" ? "success" : ""}">${escapeHtml(runtime)}</div>` : ""}
    ${conflicts.length ? `<div class="notice ${severity === "error" ? "error" : ""}">${conflicts.map((entry) => escapeHtml(conflictMessage(entry))).join("<br>")}</div>` : ""}
    <nav class="tabs" role="tablist" aria-label="A2A 配置"><button class="tab ${state.tab === "server" ? "active" : ""}" data-tab="server" role="tab" type="button">Server</button><button class="tab ${state.tab === "outgoing" ? "active" : ""}" data-tab="outgoing" role="tab" type="button">连接其他 Pi</button><button class="tab ${state.tab === "incoming" ? "active" : ""}" data-tab="incoming" role="tab" type="button">允许其他 Pi 连接</button></nav>
    <div id="tab-content">${state.tab === "server" ? serverView(workspace) : state.tab === "outgoing" ? outgoingView(workspace) : incomingView(workspace)}</div>`;
  bindWorkspaceEvents(workspace);
  refreshIcons();
}

function checkedAgentKeys(container) {
  return [...container.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
}

function bindPasswordToggle(scope = document) {
  scope.querySelectorAll(".password-toggle").forEach((button) => button.addEventListener("click", () => {
    const input = button.parentElement.querySelector("input");
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    button.setAttribute("aria-label", visible ? "显示密码" : "隐藏密码");
    button.title = visible ? "显示密码" : "隐藏密码";
    button.innerHTML = `<i data-lucide="${visible ? "eye" : "eye-off"}"></i>`;
    refreshIcons();
  }));
}

function bindFileWorkspaceEvents(workspace) {
  bindPasswordToggle($("#main-content"));
  $("#copy-file-password")?.addEventListener("click", () => copyText($("#edit-file-password").value, "密码已复制"));
  $("#file-toggle")?.addEventListener("click", async () => {
    try {
      await api(`/api/file-workspaces/${workspace.id}/${workspace.enabled ? "disable" : "enable"}`, { method: "POST", body: "{}" });
      await loadFileWorkspaces();
    } catch (error) { notify(error.message); }
  });
  $("#file-restart")?.addEventListener("click", async () => {
    try {
      await api(`/api/file-workspaces/${workspace.id}/restart`, { method: "POST", body: "{}" });
      notify("正在重新启动文件空间");
      await loadFileWorkspaces();
    } catch (error) { notify(error.message); }
  });
  $("#file-workspace-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api(`/api/file-workspaces/${workspace.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: $("#edit-file-name").value.trim(),
          listenHost: $("#edit-file-listen-host").value.trim(),
          port: Number($("#edit-file-port").value),
          publicUrl: $("#edit-file-public-url").value.trim(),
          username: $("#edit-file-username").value.trim(),
          password: $("#edit-file-password").value,
          boundAgentKeys: checkedAgentKeys($("#edit-file-agents")),
        }),
      });
      notify("文件空间已保存");
      await loadFileWorkspaces();
    } catch (error) { notify(error.message); }
  });
}

function mergeDraft(patch) {
  state.draft = {
    ...(state.draft || {}), ...patch,
    server: { ...(state.draft?.server || {}), ...(patch.server || {}) },
    workspaceConfig: { ...(state.draft?.workspaceConfig || {}), ...(patch.workspaceConfig || {}) },
  };
  $("#save-bar").classList.add("show");
}

function draftHasChanges(draft) {
  if (!draft) return false;
  if (draft.instanceId !== undefined) return true;
  if (Object.keys(draft.server || {}).length || Object.keys(draft.workspaceConfig || {}).length) return true;
  return [draft.outgoing, draft.incoming, draft.removeOutgoing, draft.removeIncoming].some((entries) => entries?.length);
}

function updateDraftPortStatus(workspace) {
  const output = $("#draft-port-status");
  if (!output) return;
  const host = $("#server-host")?.value || workspace.server.host;
  const port = Number($("#server-port")?.value || workspace.server.port);
  const conflict = state.workspaces.find((entry) => entry.key !== workspace.key && entry.server?.port === port && (host === "0.0.0.0" || entry.server.host === "0.0.0.0" || host === entry.server.host));
  output.textContent = conflict ? `与 ${conflict.agentName} 的配置端口重复` : "未发现其他受管 Pi 使用该端口";
  output.style.color = conflict ? "var(--warning)" : "var(--muted)";
}

function bindWorkspaceEvents(workspace) {
  document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => { state.tab = button.dataset.tab; render(); }));
  $("#copy-start")?.addEventListener("click", () => copyText(workspace.startCommand, "启动命令已复制"));
  $("#preview-legacy-migration")?.addEventListener("click", async () => {
    try { showPreview(await api("/api/migrations/legacy/preview", { method: "POST", body: JSON.stringify({ workspace: workspace.workspace }) })); }
    catch (error) { notify(error.message); }
  });
  $("#server-action")?.addEventListener("click", () => workspace.server.enabled ? disableServer(workspace) : enableServer(workspace));
  $("#server-form")?.addEventListener("input", () => {
    mergeDraft({
      instanceId: $("#instance-id").value,
      server: { agentName: $("#agent-name").value, host: $("#server-host").value, port: Number($("#server-port").value), portFallback: Number($("#port-fallback").value), publicUrl: $("#public-url").value },
      workspaceConfig: { id: $("#workspace-id").value, root: workspace.workspace },
    });
    updateDraftPortStatus(workspace);
  });
  updateDraftPortStatus(workspace);
  $("#add-outgoing")?.addEventListener("click", () => openConnectionDialog("outgoing"));
  $("#add-incoming")?.addEventListener("click", () => openConnectionDialog("incoming"));
  document.querySelectorAll("[data-edit-outgoing]").forEach((button) => button.addEventListener("click", () => {
    const pending = (state.draft?.outgoing || []).find((candidate) => candidate.name === button.dataset.editOutgoing);
    const saved = workspace.peers.find((candidate) => candidate.name === button.dataset.editOutgoing);
    const entry = pending
      ? { ...pending, persisted: Boolean(pending.originalName) }
      : saved ? { ...saved, persisted: true } : null;
    if (entry) openConnectionDialog("outgoing-edit", entry);
  }));
  document.querySelectorAll("[data-remove-outgoing]").forEach((button) => button.addEventListener("click", () => requestOutgoingRemoval(workspace, button.dataset.removeOutgoing)));
  document.querySelectorAll("[data-remove-incoming]").forEach((button) => button.addEventListener("click", () => { mergeDraft({ removeIncoming: [...new Set([...(state.draft?.removeIncoming || []), button.dataset.removeIncoming])] }); render(); }));
  document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => showPrompt(workspace, button.dataset.prompt)));
  document.querySelectorAll("[data-validate]").forEach((button) => button.addEventListener("click", () => validateConnection(workspace, button.dataset.validate)));
}

async function enableServer(workspace) {
  try {
    const result = await api(`/api/instances/${workspace.key}/server/enable`, { method: "POST", body: JSON.stringify({ draft: state.draft || {} }) });
    if (result.connectionRequired) {
      state.enableToken = result.suggestedToken;
      $("#enable-peer-name").value = "";
      $("#enable-dialog").showModal();
    } else showPreview(result);
  } catch (error) { notify(error.message); }
}

function disableServer(workspace) {
  mergeDraft({ server: { enabled: false } });
  previewCurrentDraft(workspace);
}

function openConnectionDialog(mode, entry = null) {
  state.connectionMode = mode;
  state.editingConnection = entry;
  const editing = mode === "outgoing-edit";
  const outgoing = mode === "outgoing" || editing;
  $("#connection-title").textContent = editing ? "编辑远程 Pi" : outgoing ? "添加远程 Pi" : "添加连接方";
  $("#connection-description").textContent = outgoing ? "名称、URL、Token 和超时均可修改。" : "身份名称用于服务端识别远程 Pi，Token 自动生成。";
  $("#connection-fields").innerHTML = outgoing
    ? `<label for="connection-name">远程 Pi 名称</label><input class="control mono" id="connection-name" required pattern="[A-Za-z0-9._-]{1,64}" value="${escapeHtml(state.editingConnection?.name || "")}"><label for="connection-url">A2A URL</label><input class="control mono" id="connection-url" required placeholder="http://host:9910/a2a/v1" value="${escapeHtml(state.editingConnection?.url || "")}"><label for="connection-token">Token</label><input class="control mono" id="connection-token" required value="${escapeHtml(state.editingConnection?.token || "")}"><label for="connection-timeout">超时毫秒（可选）</label><input class="control mono" id="connection-timeout" type="number" min="1000" value="${escapeHtml(state.editingConnection?.timeoutMs || "")}">`
    : '<label for="connection-name">连接方身份名称</label><input class="control mono" id="connection-name" required pattern="[A-Za-z0-9._-]{1,64}"><p class="field-help">远程 Pi 必须使用相同身份名称和自动生成的独立 Token。</p>';
  $("#connection-submit").textContent = editing ? "保存修改" : "添加";
  $("#connection-dialog").showModal();
}

function requestOutgoingRemoval(workspace, name) {
  const pendingIndex = (state.draft?.outgoing || []).findIndex((entry) => entry.name === name);
  const pending = pendingIndex >= 0 ? state.draft.outgoing[pendingIndex] : null;
  if (pending && !pending.originalName) {
    const outgoing = state.draft.outgoing.filter((_, index) => index !== pendingIndex);
    state.draft = { ...state.draft, outgoing };
    if (!draftHasChanges(state.draft)) state.draft = null;
    render();
    return;
  }
  const persistedName = pending?.originalName || name;
  if (pending) {
    state.draft = { ...state.draft, outgoing: state.draft.outgoing.filter((_, index) => index !== pendingIndex) };
    if (!draftHasChanges(state.draft)) state.draft = null;
    render();
  }
  state.deleteConnection = { workspace, name: persistedName };
  $("#delete-connection-name").textContent = persistedName;
  $("#delete-dialog").showModal();
}

function showPrompt(workspace, name) {
  const connection = [...workspace.inbound, ...(state.draft?.incoming || [])].find((entry) => entry.name === name);
  if (!connection) return;
  const origin = (workspace.server.publicUrl || `http://${workspace.server.host}:${workspace.actualPort || workspace.server.port}`).replace(/\/+$/, "");
  if (origin.includes("://0.0.0.0")) {
    notify("请先在 Server 配置中填写其他电脑可访问的对外地址");
    return;
  }
  const url = origin.endsWith("/a2a/v1") ? origin : `${origin}/a2a/v1`;
  $("#connection-prompt").textContent = `请为当前 Pi 配置一个 A2A client 连接。\n\n远程 Pi 名称：${workspace.agentName}\nA2A URL：${url}\n当前 Pi 在远程 Server 上的身份：${name}\n连接 Token：${connection.token}\n\n请把连接写入当前 Pi 的 settings.json 和 .env.local，保留其他配置，完成后提示用户执行 /reload。`;
  $("#prompt-dialog").showModal();
}

async function validateConnection(workspace, name) {
  const entry = [...workspace.peers, ...(state.draft?.outgoing || [])].find((candidate) => candidate.name === name);
  if (!entry) return;
  try {
    const result = await api("/api/connections/validate", { method: "POST", body: JSON.stringify({ url: entry.url, token: entry.token }) });
    const loaded = workspace.runtimeStatus?.loadedPids || [];
    const unconfirmed = workspace.runtimeStatus?.unconfirmedPids || [];
    if (loaded.length && unconfirmed.length) notify(`远端可达；PID ${loaded.join("、")} 已加载配置，PID ${unconfirmed.join("、")} 未确认：${result.name}`);
    else if (loaded.length) notify(`远端可达，当前 Pi 已加载配置：${result.name}`);
    else notify(`远端可达，但当前 Pi 尚未确认加载系统 A2A 配置：${result.name}`);
  } catch (error) { notify(`验证失败：${error.message}`); }
}

async function previewCurrentDraft(workspace = selectedWorkspace()) {
  if (!workspace || !state.draft) return;
  try {
    showPreview(await api("/api/config/preview", { method: "POST", body: JSON.stringify({ workspace: workspace.workspace, draft: state.draft }) }));
  } catch (error) { notify(error.message); }
}

function showPreview(preview) {
  state.previewId = preview.previewId;
  $("#settings-diff").textContent = preview.settingsDiff;
  $("#env-diff").textContent = preview.envDiff;
  $("#preview-dialog").showModal();
}

function openWorkspaceDialog() {
  state.inspection = null;
  $("#workspace-path").value = "";
  $("#workspace-inspection").classList.add("hidden");
  $("#workspace-operation").classList.add("hidden");
  $("#workspace-submit").textContent = "检查目录";
  $("#workspace-submit").disabled = false;
  $("#workspace-dialog").showModal();
}

function openFileWorkspaceDialog() {
  state.fileInspection = null;
  $("#file-root").value = "";
  $("#file-inspection").classList.add("hidden");
  $("#file-create-fields").classList.add("hidden");
  setFileCreateFieldsEnabled(false);
  $("#file-workspace-submit").textContent = "检查目录";
  $("#file-workspace-dialog").showModal();
}

function setFileCreateFieldsEnabled(enabled) {
  $("#file-create-fields").querySelectorAll("input, button").forEach((control) => { control.disabled = !enabled; });
}

function renderFileInspection(inspection) {
  const target = $("#file-inspection");
  target.classList.remove("hidden");
  if (inspection.duplicateId) {
    const existing = state.fileWorkspaces.find((workspace) => workspace.id === inspection.duplicateId);
    target.innerHTML = `<div class="notice error">该目录已经属于“${escapeHtml(existing?.name || inspection.duplicateId)}”。</div><button class="button" id="show-duplicate-file-workspace" type="button">查看已有项</button>`;
    $("#show-duplicate-file-workspace").addEventListener("click", () => {
      state.selectedFileId = inspection.duplicateId;
      $("#file-workspace-dialog").close();
      render();
    });
    return;
  }
  target.innerHTML = `<strong>${escapeHtml(inspection.root)}</strong><br>目录：可读写<br>rclone：${inspection.dependencies.rclonePath ? "已安装" : "未安装"}<br>ssh-keygen：${inspection.dependencies.sshKeygenPath ? "已安装" : "未安装"}${inspection.dependencies.ready ? "" : `<pre>${escapeHtml(inspection.dependencies.install)}</pre>`}${inspection.hosts.length ? "" : '<div class="notice">无法自动判断其他电脑可访问的地址，请在高级设置中填写对外地址。</div>'}`;
  $("#file-name").value = inspection.name;
  $("#file-username").value = inspection.username;
  $("#file-password").value = "";
  $("#file-port").value = inspection.suggestedPort;
  $("#file-public-url").value = inspection.hosts[0] ? `sftp://${inspection.hosts[0].host}:${inspection.suggestedPort}` : "";
  $("#file-agent-options").innerHTML = agentOptions([]);
  $("#file-create-fields").classList.remove("hidden");
  $("#file-create-fields details").open = inspection.hosts.length === 0;
  setFileCreateFieldsEnabled(true);
  bindPasswordToggle($("#file-workspace-dialog"));
  $("#copy-file-create-password").onclick = () => copyText($("#file-password").value, "密码已复制");
  refreshIcons();
}

function renderInspection(inspection) {
  const target = $("#workspace-inspection");
  target.classList.remove("hidden");
  target.innerHTML = `<strong>${escapeHtml(inspection.folderName)}</strong><br>系统 Agent 配置：${escapeHtml(inspection.agentDir)}<br>.pi/settings.json：${inspection.projectSettingsExists ? "已存在，只读合并" : "不存在"}<br>系统 A2A profile：${inspection.existingA2a ? "已存在，保留" : "不存在，将创建"}<br>${inspection.legacyA2aExists ? `<span class="warning-text">检测到旧专属配置：${escapeHtml(inspection.legacySettingsPath)}，不会自动覆盖系统配置</span><br>` : ""}Agent 名称：${escapeHtml(inspection.agentName)}<br>建议端口：${inspection.suggestedPort}<br>pi-a2a：${inspection.plugin.configured ? inspection.plugin.available ? "系统已配置且来源可用" : "系统已配置但来源不可用" : "系统未配置；本工具不会自动安装"}`;
}

function renderOperation(operation) {
  const stages = ["inspect", "configure", "complete"];
  const current = stages.indexOf(operation.stage);
  const names = { inspect: "检查目录", configure: "写入系统 Pi profile", complete: "完成" };
  const target = $("#workspace-operation");
  target.classList.remove("hidden");
  target.innerHTML = `<div class="stage-list">${stages.map((stage, index) => `<span class="stage ${index < current ? "done" : index === current ? "current" : ""}">${names[stage]}</span>`).join("")}</div>${operation.error ? `<div class="notice error">${escapeHtml(operation.error)}${operation.retryCommand ? `<pre>${escapeHtml(operation.retryCommand)}</pre>` : ""}</div>` : ""}`;
}

async function pollOperation(id) {
  while (true) {
    const operation = await api(`/api/operations/${id}`);
    renderOperation(operation);
    if (operation.status === "complete") {
      state.selectedKey = operation.result.instance.key;
      notify("工作目录已配置完成");
      $("#workspace-dialog").close();
      await loadState();
      return;
    }
    if (operation.status === "error") {
      $("#workspace-submit").textContent = "重试";
      $("#workspace-submit").disabled = false;
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
  }
}

async function loadState() {
  try {
    const [payload, files] = await Promise.all([api("/api/state"), api("/api/file-workspaces")]);
    state.workspaces = payload.workspaces;
    state.fileWorkspaces = files.fileWorkspaces;
    state.fileDependencies = files.dependencies;
    if (!selectedWorkspace()) state.selectedKey = state.workspaces[0]?.key || null;
    if (!selectedFileWorkspace()) state.selectedFileId = state.fileWorkspaces[0]?.id || null;
    $("#refreshed-at").textContent = `刷新于 ${new Date().toLocaleTimeString()}`;
    render();
  } catch (error) { notify(error.message); }
}

async function loadFileWorkspaces() {
  const payload = await api("/api/file-workspaces");
  state.fileWorkspaces = payload.fileWorkspaces;
  state.fileDependencies = payload.dependencies;
  if (!selectedFileWorkspace()) state.selectedFileId = state.fileWorkspaces[0]?.id || null;
  render();
}

async function refreshPortStatus() {
  try {
    const [payload, files] = await Promise.all([api("/api/port-status"), api("/api/file-workspaces/status")]);
    const byKey = new Map(payload.statuses.map((status) => [status.key, status]));
    const runtimeByKey = new Map(payload.runtimeStatuses.map((status) => [status.key, status]));
    state.workspaces = state.workspaces.map((workspace) => ({ ...workspace, portStatus: byKey.get(workspace.key) || workspace.portStatus, runtimeStatus: runtimeByKey.get(workspace.key) || workspace.runtimeStatus }));
    const fileStatusById = new Map(files.statuses.map((status) => [status.id, status]));
    state.fileWorkspaces = state.fileWorkspaces.map((workspace) => ({ ...workspace, status: fileStatusById.get(workspace.id) || workspace.status }));
    $("#refreshed-at").textContent = `端口状态 ${new Date(payload.refreshedAt).toLocaleTimeString()}`;
    render();
  } catch (error) { notify(error.message); }
}

async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); notify(message); }
  catch { notify("无法访问剪贴板"); }
}

function closeNavigation() {
  $("#sidebar").classList.remove("open");
  $("#nav-scrim").classList.remove("open");
}

$("#add-workspace").addEventListener("click", openWorkspaceDialog);
$("#add-file-workspace").addEventListener("click", openFileWorkspaceDialog);
$("#module-agents").addEventListener("click", () => { state.module = "agents"; closeNavigation(); render(); });
$("#module-files").addEventListener("click", () => { state.module = "files"; closeNavigation(); render(); });
$("#refresh").addEventListener("click", loadState);
$("#open-nav").addEventListener("click", () => { $("#sidebar").classList.add("open"); $("#nav-scrim").classList.add("open"); });
$("#nav-scrim").addEventListener("click", closeNavigation);
$("#discard").addEventListener("click", () => { state.draft = null; render(); });
$("#preview").addEventListener("click", () => previewCurrentDraft());
$("#copy-prompt").addEventListener("click", () => copyText($("#connection-prompt").textContent, "Prompt 已复制"));
$("#apply-preview").addEventListener("click", async () => {
  try {
    const result = await api("/api/config/apply", { method: "POST", body: JSON.stringify({ previewId: state.previewId }) });
    state.draft = null;
    $("#preview-dialog").close();
    notify(result.instance.registry.length || result.instance.runtime.length ? "配置已保存，请在 Pi 执行 /reload" : "配置已保存，下次启动 Pi 时生效");
    await loadState();
  } catch (error) { notify(error.message); }
});

$("#workspace-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#workspace-submit");
  button.disabled = true;
  try {
    if (!state.inspection) {
      state.inspection = await api("/api/workspaces/inspect", { method: "POST", body: JSON.stringify({ path: $("#workspace-path").value }) });
      renderInspection(state.inspection);
      button.textContent = "添加并配置";
      return;
    }
    const operation = await api("/api/workspaces", { method: "POST", body: JSON.stringify({ path: state.inspection.workspace }) });
    renderOperation(operation);
    button.textContent = "处理中";
    await pollOperation(operation.id);
  } catch (error) { notify(error.message); }
  finally { if ($("#workspace-dialog").open) button.disabled = false; }
});

$("#workspace-path").addEventListener("input", () => {
  state.inspection = null;
  $("#workspace-inspection").classList.add("hidden");
  $("#workspace-operation").classList.add("hidden");
  $("#workspace-submit").textContent = "检查目录";
});

$("#file-root").addEventListener("input", () => {
  state.fileInspection = null;
  $("#file-inspection").classList.add("hidden");
  $("#file-create-fields").classList.add("hidden");
  setFileCreateFieldsEnabled(false);
  $("#file-workspace-submit").textContent = "检查目录";
});

$("#file-port").addEventListener("input", () => {
  if (!state.fileInspection?.hosts[0]) return;
  $("#file-public-url").value = `sftp://${state.fileInspection.hosts[0].host}:${$("#file-port").value}`;
});

$("#file-workspace-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#file-workspace-submit");
  button.disabled = true;
  try {
    if (!state.fileInspection) {
      state.fileInspection = await api("/api/file-workspaces/inspect", { method: "POST", body: JSON.stringify({ root: $("#file-root").value }) });
      renderFileInspection(state.fileInspection);
      button.textContent = "创建并启动";
      button.disabled = Boolean(state.fileInspection.duplicateId || !state.fileInspection.dependencies.ready);
      return;
    }
    const boundAgentKeys = checkedAgentKeys($("#file-agent-options"));
    if (!boundAgentKeys.length) throw new Error("请至少关联一个 Agent");
    const created = await api("/api/file-workspaces", {
      method: "POST",
      body: JSON.stringify({
        root: state.fileInspection.root,
        name: $("#file-name").value.trim(),
        username: $("#file-username").value.trim(),
        password: $("#file-password").value,
        listenHost: $("#file-listen-host").value.trim(),
        port: Number($("#file-port").value),
        publicUrl: $("#file-public-url").value.trim(),
        boundAgentKeys,
      }),
    });
    state.selectedFileId = created.id;
    $("#file-workspace-dialog").close();
    notify("文件空间已创建，正在启动");
    await loadFileWorkspaces();
  } catch (error) { notify(error.message); }
  finally { if ($("#file-workspace-dialog").open && !state.fileInspection?.duplicateId && state.fileInspection?.dependencies.ready) button.disabled = false; }
});

$("#connection-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("#connection-name").value.trim();
  if (state.connectionMode === "outgoing" || state.connectionMode === "outgoing-edit") {
    const draftIdentity = state.editingConnection?.originalName || state.editingConnection?.name;
    const outgoing = (state.draft?.outgoing || []).filter((entry) => (entry.originalName || entry.name) !== draftIdentity);
    const originalName = state.editingConnection?.persisted ? draftIdentity : undefined;
    const removeOutgoing = (state.draft?.removeOutgoing || []).filter((entry) => entry !== name && entry !== originalName);
    mergeDraft({ outgoing: [...outgoing, { name, originalName, url: $("#connection-url").value.trim(), token: $("#connection-token").value, timeoutMs: $("#connection-timeout").value ? Number($("#connection-timeout").value) : null }], removeOutgoing });
  } else {
    mergeDraft({ incoming: [...(state.draft?.incoming || []), { name, token: `a2a_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}` }] });
  }
  $("#connection-dialog").close();
  render();
});

$("#confirm-delete").addEventListener("click", async () => {
  const target = state.deleteConnection;
  if (!target) return;
  mergeDraft({ removeOutgoing: [...new Set([...(state.draft?.removeOutgoing || []), target.name])] });
  $("#delete-dialog").close();
  state.deleteConnection = null;
  render();
  await previewCurrentDraft(target.workspace);
});

$("#enable-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const workspace = selectedWorkspace();
  try {
    const result = await api(`/api/instances/${workspace.key}/server/enable`, { method: "POST", body: JSON.stringify({ connectionName: $("#enable-peer-name").value.trim(), token: state.enableToken, draft: state.draft || {} }) });
    $("#enable-dialog").close();
    showPreview(result);
  } catch (error) { notify(error.message); }
});

document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));

await loadState();
setInterval(refreshPortStatus, 30_000);
