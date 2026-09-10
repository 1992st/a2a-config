const state = {
  workspaces: [],
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
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

async function api(path, options = {}) {
  const response = await fetch(path, {
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

function hasConfiguredConnection(workspace) {
  return workspace.server.enabled || workspace.peers.length > 0 || workspace.inbound.length > 0;
}

function connectionStatus(workspace) {
  if (workspace.operation?.status === "running") return { title: "插件安装中", detail: `正在执行：${workspace.operation.stage}` };
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
  if (loaded.length && unconfirmed.length) return `PID ${loaded.join("、")} 已加载专属配置；PID ${unconfirmed.join("、")} 未确认加载 .pi/agent。请退出未确认的 Pi 进程。`;
  if (loaded.length) return `当前 Pi 已加载专属配置（PID ${loaded.join("、")}）`;
  if (unconfirmed.length) return `检测到 Pi 正在此工作目录运行（PID ${unconfirmed.join("、")}），但无法确认它加载了 .pi/agent。请退出该 Pi，并使用“复制启动命令”重新启动。`;
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
    ${!workspace.plugin.installed ? '<div class="notice error">A2A 插件未安装。重新添加此工作目录可重试安装。</div>' : ""}
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
    ${runtime ? `<div class="notice ${runtimeStatus.status === "loaded" ? "success" : ""}">${escapeHtml(runtime)}</div>` : ""}
    ${conflicts.length ? `<div class="notice ${severity === "error" ? "error" : ""}">${conflicts.map((entry) => escapeHtml(conflictMessage(entry))).join("<br>")}</div>` : ""}
    <nav class="tabs" role="tablist" aria-label="A2A 配置"><button class="tab ${state.tab === "server" ? "active" : ""}" data-tab="server" role="tab" type="button">Server</button><button class="tab ${state.tab === "outgoing" ? "active" : ""}" data-tab="outgoing" role="tab" type="button">连接其他 Pi</button><button class="tab ${state.tab === "incoming" ? "active" : ""}" data-tab="incoming" role="tab" type="button">允许其他 Pi 连接</button></nav>
    <div id="tab-content">${state.tab === "server" ? serverView(workspace) : state.tab === "outgoing" ? outgoingView(workspace) : incomingView(workspace)}</div>`;
  bindWorkspaceEvents(workspace);
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
    else notify(`远端可达，但当前 Pi 尚未确认加载专属配置：${result.name}`);
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

function renderInspection(inspection) {
  const target = $("#workspace-inspection");
  target.classList.remove("hidden");
  target.innerHTML = `<strong>${escapeHtml(inspection.folderName)}</strong><br>.pi 目录：${inspection.piExists ? "已存在，保留全部内容" : "不存在，将自动创建"}<br>.pi/agent/settings.json：${inspection.agentSettingsExists ? "已存在，保留其他配置" : "不存在，将自动创建"}<br>.pi/settings.json：${inspection.projectSettingsExists ? "已存在，只读" : "不存在，按设计不创建"}<br>专属 A2A：${inspection.existingA2a ? "已存在，不修改" : "不存在，将创建"}<br>Agent 名称：${escapeHtml(inspection.agentName)}<br>建议端口：${inspection.suggestedPort}<br>插件：${inspection.plugin.installed ? "已安装" : "将自动安装"}`;
}

function renderOperation(operation) {
  const stages = ["inspect", "create", "configure", "install", "complete"];
  const current = stages.indexOf(operation.stage);
  const names = { inspect: "检查目录", create: "创建专属 Pi", configure: "写入 A2A 配置", install: "安装插件", complete: "完成" };
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
    const payload = await api("/api/state");
    state.workspaces = payload.workspaces;
    if (!selectedWorkspace()) state.selectedKey = state.workspaces[0]?.key || null;
    $("#refreshed-at").textContent = `刷新于 ${new Date().toLocaleTimeString()}`;
    render();
  } catch (error) { notify(error.message); }
}

async function refreshPortStatus() {
  try {
    const payload = await api("/api/port-status");
    const byKey = new Map(payload.statuses.map((status) => [status.key, status]));
    const runtimeByKey = new Map(payload.runtimeStatuses.map((status) => [status.key, status]));
    state.workspaces = state.workspaces.map((workspace) => ({ ...workspace, portStatus: byKey.get(workspace.key) || workspace.portStatus, runtimeStatus: runtimeByKey.get(workspace.key) || workspace.runtimeStatus }));
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
