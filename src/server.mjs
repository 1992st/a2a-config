import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireLocks,
  applyWorkspaceDraft,
  buildPortStatus,
  buildRuntimeStatuses,
  createToken,
  fileMode,
  findPiInstallations,
  findRunningPiProcesses,
  hashText,
  initializeWorkspace,
  inspectWorkspace,
  isRecord,
  normalizeWorkspacePath,
  probePort,
  readJsonFile,
  readState,
  readWorkspace,
  removeWorkspaceFromState,
  renameSecretText,
  resolvePluginSource,
  secretUpdateFromDraft,
  updateSecretText,
  workspaceKey,
  writeAtomically,
  STATE_FILE,
} from "./core.mjs";
import { dependencyStatus, FileTransferManager, removeRuntimeDescriptors, writeRuntimeDescriptors } from "./file-transfer.mjs";

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SOURCE_ROOT, "..");
const STATIC_ROOT = join(APP_ROOT, "web");
const LUCIDE_PATH = join(APP_ROOT, "node_modules", "lucide", "dist", "umd", "lucide.min.js");
const ADMIN_TOKEN = process.env.A2A_CONFIG_ADMIN_TOKEN || "";
const PROXY_TOKEN = process.env.A2A_CONFIG_PROXY_TOKEN || "";
const SESSION_TOKEN = PROXY_TOKEN || randomBytes(32).toString("hex");
const BASE_PATH = normalizeBasePath(process.env.A2A_CONFIG_BASE_PATH || "");
const operations = new Map();
const previews = new Map();
let initializationQueue = Promise.resolve();
const fileTransferManager = new FileTransferManager({ stateFile: STATE_FILE });
let runtimeDescriptorInstances = [];
let appLoopbackUrl = "";

function valueFromArgs(name, fallback) {
  const args = process.argv.slice(2);
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const SERVER_HOST = valueFromArgs("--host", process.env.A2A_CONFIG_HOST || "127.0.0.1");
const SERVER_PORT = Number(valueFromArgs("--port", process.env.A2A_CONFIG_PORT || 0));

function pluginSourceFromArgs(args = process.argv.slice(2)) {
  const equals = args.find((arg) => arg.startsWith("--plugin-source="));
  if (equals) return equals.slice("--plugin-source=".length);
  const index = args.indexOf("--plugin-source");
  return index >= 0 ? args[index + 1] : undefined;
}

const pluginSource = resolvePluginSource(APP_ROOT, pluginSourceFromArgs());
const piInstallations = findPiInstallations();
const piExecutable = process.env.A2A_CONFIG_PI || piInstallations[0]?.executablePath;

function normalizeBasePath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return "";
  const normalized = `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
  if (normalized.includes("//") || normalized.includes("..")) throw new Error("A2A_CONFIG_BASE_PATH 格式无效");
  return normalized;
}

function joinBasePath(pathname, basePath = BASE_PATH) {
  const path = String(pathname || "/");
  if (!basePath) return path.startsWith("/") ? path : `/${path}`;
  return `${basePath}${path.startsWith("/") ? path : `/${path}`}`.replace(/\/{2,}/g, "/");
}

function stripBasePath(pathname, basePath = BASE_PATH) {
  const path = String(pathname || "/");
  if (!basePath) return path || "/";
  if (path === basePath || path === `${basePath}/`) return "/";
  if (!path.startsWith(`${basePath}/`)) return null;
  return path.slice(basePath.length) || "/";
}

function sessionCookie() {
  return `a2a_config_session=${SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=${BASE_PATH || "/"}`;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendError(response, status, code, message, details) {
  sendJson(response, status, { error: { code, message, ...(details === undefined ? {} : { details }) } });
}

function readRequestBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("请求内容超过 2 MiB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("请求内容不是有效 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function cookieValue(request, name) {
  return String(request.headers.cookie || "")
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function authenticate(request, response) {
  if (PROXY_TOKEN && tokenMatches(request.headers["x-a2a-config-proxy-token"], PROXY_TOKEN)) return true;
  if (cookieValue(request, "a2a_config_session") !== SESSION_TOKEN) {
    sendError(response, 401, "UNAUTHORIZED", "本地会话已失效，请重新打开工具");
    return false;
  }
  if (request.method !== "GET" && request.headers.origin) {
    const allowed = new Set([`http://${request.headers.host}`, `https://${request.headers.host}`]);
    if (!allowed.has(String(request.headers.origin))) {
      sendError(response, 403, "BAD_ORIGIN", "请求来源不匹配");
      return false;
    }
  }
  return true;
}

function isLoopbackAddress(address) {
  const value = String(address || "").replace(/^::ffff:/, "");
  return value === "127.0.0.1" || value === "::1";
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function readManagedInstances() {
  return readState().map((workspace) => {
    try {
      return { ...readWorkspace(workspace), error: null };
    } catch (error) {
      return {
        key: workspaceKey(resolve(workspace)),
        workspace: resolve(workspace),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function operationForWorkspace(workspace) {
  return [...operations.values()]
    .filter((operation) => operation.workspace === workspace)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

async function statePayload() {
  const instances = readManagedInstances();
  const validInstances = instances.filter((instance) => !instance.error);
  const monitoring = await monitorInstances(validInstances);
  const portStatuses = monitoring.statuses;
  const portByKey = new Map(portStatuses.map((entry) => [entry.key, entry]));
  const runtimeByKey = new Map(monitoring.runtimeStatuses.map((entry) => [entry.key, entry]));
  return {
    workspaces: instances.map((instance) => ({
      ...instance,
      portStatus: portByKey.get(instance.key),
      runtimeStatus: runtimeByKey.get(instance.key),
      operation: operationForWorkspace(instance.workspace),
    })),
    pluginSource: pluginSource || null,
    piInstallation: piInstallations[0] || null,
    refreshIntervalMs: 30_000,
  };
}

async function monitorInstances(instances) {
  const runningProcesses = findRunningPiProcesses(instances.map((instance) => instance.workspace));
  return {
    statuses: await buildPortStatus(instances),
    runtimeStatuses: buildRuntimeStatuses(instances, runningProcesses),
    refreshedAt: new Date().toISOString(),
  };
}

function operationView(operation) {
  return {
    id: operation.id,
    workspace: operation.workspace,
    stage: operation.stage,
    status: operation.status,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.result ? { result: operation.result } : {}),
    ...(operation.error ? { error: operation.error } : {}),
    ...(operation.retryCommand ? { retryCommand: operation.retryCommand } : {}),
  };
}

function startWorkspaceInitialization(workspacePath) {
  const workspace = normalizeWorkspacePath(workspacePath);
  const operation = {
    id: randomUUID(),
    workspace,
    stage: "inspect",
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  operations.set(operation.id, operation);
  const initialization = initializationQueue.then(() => initializeWorkspace({
    workspacePath: workspace,
    managedWorkspaces: readState(),
    instances: readManagedInstances().filter((instance) => !instance.error),
    pluginSource,
    piExecutable,
    onStage(stage) {
      operation.stage = stage;
      operation.updatedAt = Date.now();
    },
  }));
  initializationQueue = initialization.catch(() => undefined);
  void initialization.then((result) => {
    operation.stage = "complete";
    operation.status = "complete";
    operation.result = result;
    operation.updatedAt = Date.now();
    if (appLoopbackUrl) {
      runtimeDescriptorInstances = readManagedInstances().filter((instance) => !instance.error);
      writeRuntimeDescriptors(runtimeDescriptorInstances, appLoopbackUrl);
    }
  }).catch((error) => {
    operation.stage = "error";
    operation.status = "error";
    operation.error = error instanceof Error ? error.message : String(error);
    operation.retryCommand = error && typeof error === "object" ? error.retryCommand : undefined;
    operation.updatedAt = Date.now();
  });
  return operationView(operation);
}

function validateDraft(instance, draft) {
  const instanceId = draft.instanceId ?? instance.instanceId;
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(instanceId)) throw new Error("instanceId 格式无效");
  if (draft.server?.port !== undefined) {
    const port = Number(draft.server.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须是 1 到 65535 的整数");
  }
  if (draft.server?.portFallback !== undefined) {
    const fallback = Number(draft.server.portFallback);
    if (!Number.isInteger(fallback) || fallback < 0 || fallback > 100) throw new Error("备用端口数量必须是 0 到 100 的整数");
  }
  for (const entry of [...(draft.outgoing || []), ...(draft.incoming || [])]) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(entry.name)) throw new Error(`连接名称格式无效：${entry.name}`);
  }
  for (const entry of draft.outgoing || []) {
    let parsed;
    try { parsed = new URL(entry.url); } catch { throw new Error(`A2A URL 无效：${entry.url}`); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("A2A URL 只支持 http/https");
    if (entry.timeoutMs !== undefined && entry.timeoutMs !== null) {
      const timeout = Number(entry.timeoutMs);
      if (!Number.isInteger(timeout) || timeout < 1000) throw new Error("连接超时必须是不小于 1000 的整数");
    }
  }
}

function envSnapshot(path) {
  if (!existsSync(path)) return { exists: false, text: "", hash: null };
  const text = readFileSync(path, "utf8");
  return { exists: true, text, hash: hashText(text) };
}

function createPreview(workspacePath, draft) {
  const instance = readWorkspace(workspacePath);
  validateDraft(instance, draft);
  const settings = readJsonFile(instance.settingsPath, { required: true });
  const env = envSnapshot(instance.envPath);
  const nextSettings = applyWorkspaceDraft(settings.value, instance.workspace, draft);
  const nextInstanceId = draft.instanceId || instance.instanceId;
  let nextEnv = nextInstanceId === instance.instanceId
    ? env.text
    : renameSecretText(env.text, instance.instanceId, nextInstanceId);
  const secretUpdate = secretUpdateFromDraft(draft);
  if (secretUpdate) nextEnv = updateSecretText(nextEnv, nextInstanceId, secretUpdate);
  const settingsText = `${JSON.stringify(nextSettings, null, 2)}\n`;
  const preview = {
    id: randomUUID(),
    workspace: instance.workspace,
    settingsPath: instance.settingsPath,
    envPath: instance.envPath,
    settingsHash: settings.hash,
    envHash: env.hash,
    envExisted: env.exists,
    previousSettings: settings.text,
    previousEnv: env.text,
    settingsText,
    envText: nextEnv,
    envChanged: nextEnv !== env.text,
    expiresAt: Date.now() + 300_000,
  };
  previews.set(preview.id, preview);
  return {
    previewId: preview.id,
    settingsDiff: `${settings.text}\n---\n${settingsText}`,
    envDiff: preview.envChanged ? `${env.text}\n---\n${nextEnv}` : "无 secret 修改",
  };
}

function applyPreview(previewId) {
  const preview = previews.get(previewId);
  if (!preview || preview.expiresAt < Date.now()) {
    previews.delete(previewId);
    throw Object.assign(new Error("预览已失效，请重新生成"), { code: "PREVIEW_EXPIRED", status: 409 });
  }
  const release = acquireLocks([preview.settingsPath, preview.envPath]);
  try {
    const settings = readJsonFile(preview.settingsPath, { required: true });
    const env = envSnapshot(preview.envPath);
    if (settings.hash !== preview.settingsHash || env.hash !== preview.envHash) {
      throw Object.assign(new Error("Pi 配置在预览后发生变化，请刷新后重试"), { code: "CONFIG_CHANGED", status: 409 });
    }
    try {
      if (preview.envChanged) writeAtomically(preview.envPath, preview.envText, fileMode(preview.envPath));
      writeAtomically(preview.settingsPath, preview.settingsText, fileMode(preview.settingsPath));
    } catch (error) {
      try {
        if (preview.envChanged) {
          if (preview.envExisted) writeAtomically(preview.envPath, preview.previousEnv, fileMode(preview.envPath));
          else if (existsSync(preview.envPath)) unlinkSync(preview.envPath);
        }
        writeAtomically(preview.settingsPath, preview.previousSettings, fileMode(preview.settingsPath));
      } catch (rollbackError) {
        throw Object.assign(new Error("保存失败，且配置回滚失败"), {
          code: "ROLLBACK_FAILED",
          status: 500,
          details: { save: String(error), rollback: String(rollbackError) },
        });
      }
      throw Object.assign(new Error("保存失败，原配置已恢复"), { code: "SAVE_FAILED", status: 500, details: String(error) });
    }
    previews.delete(previewId);
    return { ok: true, reloadRequired: true, instance: readWorkspace(preview.workspace) };
  } finally {
    release();
  }
}

function instanceByKey(key) {
  return readManagedInstances().find((instance) => instance.key === key && !instance.error);
}

async function verifyConnection(input) {
  const base = String(input.url || "").replace(/\/+$/, "");
  let parsedBase;
  try { parsedBase = new URL(base); } catch { throw new Error("A2A URL 无效"); }
  if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") throw new Error("A2A URL 只支持 http/https");
  if (parsedBase.username || parsedBase.password) throw new Error("A2A URL 不能包含用户名或密码");
  const headers = input.token ? { authorization: `Bearer ${input.token}` } : {};
  let cardResponse = await fetch(`${base}/.well-known/agent-card.json`, { headers, redirect: "error", signal: AbortSignal.timeout(5000) });
  if (cardResponse.status === 404) {
    cardResponse = await fetch(`${base}/.well-known/agent.json`, { headers, redirect: "error", signal: AbortSignal.timeout(5000) });
  }
  if (!cardResponse.ok) throw new Error(`Agent Card HTTP ${cardResponse.status}`);
  const card = await cardResponse.json();
  const endpoint = card.supportedInterfaces?.find((entry) => entry.protocolBinding === "JSONRPC")?.url || card.url || base;
  const endpointUrl = new URL(endpoint, base);
  if (endpointUrl.origin !== parsedBase.origin) throw new Error("Agent Card endpoint 必须与输入 URL 同源");
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: { "content-type": "application/a2a+json", ...headers },
    redirect: "error",
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "GetTask", params: { id: `a2a-config-probe-${randomUUID()}` } }),
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  const expectedNotFound = result.error?.code === -32001 || String(result.error?.message || "").toLowerCase().includes("not found");
  if (!expectedNotFound && (!response.ok || result.error)) throw new Error(result.error?.message || `验证请求 HTTP ${response.status}`);
  return {
    name: card.name || "未命名 Pi",
    endpoint: endpointUrl.toString(),
    skills: Array.isArray(card.skills) ? card.skills.map((entry) => entry.name || entry.id).filter(Boolean) : [],
  };
}

function serveFile(response, path, options = {}) {
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  try {
    const type = contentTypes[extname(path)] || "application/octet-stream";
    let content = readFileSync(path);
    if (type.startsWith("text/html")) {
      content = Buffer.from(content.toString("utf8").replaceAll("__A2A_CONFIG_BASE_PATH__", options.basePath ?? BASE_PATH));
    }
    response.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    response.end(content);
  } catch {
    sendError(response, 404, "NOT_FOUND", "页面不存在");
  }
}

async function chooseCandidatePort() {
  const instances = readManagedInstances().filter((entry) => !entry.error);
  const used = new Set(instances.flatMap((entry) => [entry.server.port, entry.actualPort]).filter(Number.isInteger));
  for (let port = 9910; port <= 65535; port += 1) {
    if (!used.has(port) && await probePort("0.0.0.0", port)) return port;
  }
  throw new Error("没有可用 A2A 端口");
}

function readDirectories(path) {
  return readdirSync(path).filter((name) => {
    try { return !name.startsWith(".") && statSync(join(path, name)).isDirectory(); } catch { return false; }
  }).slice(0, 200);
}

const httpServer = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const pathname = stripBasePath(url.pathname);
  if (pathname === null) {
    sendError(response, 404, "NOT_FOUND", "页面不存在");
    return;
  }
  url.pathname = pathname;
  if (PROXY_TOKEN && pathname !== "/api/agent/file-workspaces" && !tokenMatches(request.headers["x-a2a-config-proxy-token"], PROXY_TOKEN)) {
    sendError(response, 403, "PROXY_REQUIRED", "管理页面只能通过宿主应用访问");
    return;
  }
  if (pathname === "/" && request.method === "GET") {
    if (ADMIN_TOKEN && !isLoopbackAddress(request.socket.remoteAddress) && cookieValue(request, "a2a_config_session") !== SESSION_TOKEN) {
      serveFile(response, join(STATIC_ROOT, "login.html"), { basePath: BASE_PATH });
      return;
    }
    response.setHeader("set-cookie", sessionCookie());
    serveFile(response, join(STATIC_ROOT, "index.html"), { basePath: BASE_PATH });
    return;
  }
  if (pathname === "/vendor/lucide.js" && request.method === "GET") {
    serveFile(response, LUCIDE_PATH);
    return;
  }
  if (pathname === "/api/login" && request.method === "POST") {
    try {
      const body = await readRequestBody(request);
      if (!ADMIN_TOKEN || !tokenMatches(body.token, ADMIN_TOKEN)) {
        sendError(response, 401, "INVALID_TOKEN", "管理 Token 不正确");
        return;
      }
      response.setHeader("set-cookie", sessionCookie());
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendError(response, 400, "REQUEST_FAILED", error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (pathname === "/api/agent/file-workspaces" && request.method === "GET") {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendError(response, 403, "LOOPBACK_REQUIRED", "Agent 文件空间接口只允许本机访问");
      return;
    }
    try {
      const instances = readManagedInstances().filter((instance) => !instance.error);
      sendJson(response, 200, { fileWorkspaces: fileTransferManager.connectionInfo(url.searchParams.get("agentId") || "", instances) });
    } catch (error) {
      sendError(response, 400, "REQUEST_FAILED", error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (pathname.startsWith("/api/") && !authenticate(request, response)) return;
  try {
    if (pathname === "/api/state" && request.method === "GET") {
      sendJson(response, 200, await statePayload());
      return;
    }
    if (pathname === "/api/workspaces/inspect" && request.method === "POST") {
      const body = await readRequestBody(request);
      const inspection = inspectWorkspace(body.path, readState());
      const suggestedPort = inspection.existingA2a ? readWorkspace(inspection.workspace).server.port : await chooseCandidatePort();
      sendJson(response, 200, { ...inspection, suggestedPort, pluginSource: pluginSource || null, piExecutable: piExecutable || null });
      return;
    }
    if (pathname === "/api/workspaces" && request.method === "POST") {
      const body = await readRequestBody(request);
      sendJson(response, 202, startWorkspaceInitialization(body.path));
      return;
    }
    if (pathname.startsWith("/api/workspaces/") && request.method === "DELETE") {
      const key = pathname.split("/").at(-1);
      const instance = readManagedInstances().find((entry) => entry.key === key);
      if (!instance) {
        sendError(response, 404, "NOT_FOUND", "工作目录不存在");
        return;
      }
      removeWorkspaceFromState(instance.workspace);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (pathname.startsWith("/api/operations/") && request.method === "GET") {
      const operation = operations.get(pathname.split("/").at(-1));
      if (!operation) {
        sendError(response, 404, "NOT_FOUND", "初始化任务不存在");
        return;
      }
      sendJson(response, 200, operationView(operation));
      return;
    }
    if (pathname === "/api/port-status" && request.method === "GET") {
      const instances = readManagedInstances().filter((entry) => !entry.error);
      sendJson(response, 200, await monitorInstances(instances));
      return;
    }
    if (pathname === "/api/file-workspaces" && request.method === "GET") {
      sendJson(response, 200, { fileWorkspaces: fileTransferManager.list(), dependencies: dependencyStatus() });
      return;
    }
    if (pathname === "/api/file-workspaces/inspect" && request.method === "POST") {
      const body = await readRequestBody(request);
      const instances = readManagedInstances().filter((instance) => !instance.error);
      sendJson(response, 200, await fileTransferManager.inspect(body.root, instances, instances));
      return;
    }
    if (pathname === "/api/file-workspaces" && request.method === "POST") {
      const instances = readManagedInstances().filter((instance) => !instance.error);
      sendJson(response, 201, await fileTransferManager.create(await readRequestBody(request), instances, instances));
      return;
    }
    if (pathname === "/api/file-workspaces/status" && request.method === "GET") {
      sendJson(response, 200, { statuses: await fileTransferManager.monitoredStatuses(), refreshedAt: new Date().toISOString() });
      return;
    }
    const fileWorkspaceMatch = /^\/api\/file-workspaces\/([^/]+)(?:\/(enable|disable|restart|agents))?$/.exec(pathname);
    if (fileWorkspaceMatch) {
      const id = decodeURIComponent(fileWorkspaceMatch[1]);
      const action = fileWorkspaceMatch[2];
      const instances = readManagedInstances().filter((instance) => !instance.error);
      if (request.method === "PUT" && !action) {
        sendJson(response, 200, await fileTransferManager.update(id, await readRequestBody(request), instances));
        return;
      }
      if (request.method === "PUT" && action === "agents") {
        const body = await readRequestBody(request);
        sendJson(response, 200, await fileTransferManager.update(id, { boundAgentKeys: body.boundAgentKeys }, instances));
        return;
      }
      if (request.method === "POST" && action === "enable") {
        sendJson(response, 200, await fileTransferManager.setEnabled(id, true));
        return;
      }
      if (request.method === "POST" && action === "disable") {
        sendJson(response, 200, await fileTransferManager.setEnabled(id, false));
        return;
      }
      if (request.method === "POST" && action === "restart") {
        sendJson(response, 200, await fileTransferManager.restart(id));
        return;
      }
    }
    if (pathname === "/api/ports/check" && request.method === "POST") {
      const body = await readRequestBody(request);
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须是 1 到 65535 的整数");
      sendJson(response, 200, { host: body.host || "0.0.0.0", port, available: await probePort(body.host || "0.0.0.0", port) });
      return;
    }
    if (pathname.startsWith("/api/instances/") && pathname.endsWith("/server/enable") && request.method === "POST") {
      const key = pathname.split("/")[3];
      const instance = instanceByKey(key);
      if (!instance) throw Object.assign(new Error("实例不存在"), { status: 404, code: "NOT_FOUND" });
      if (!instance.plugin.installed) throw Object.assign(new Error("A2A 插件尚未安装"), { status: 409, code: "PLUGIN_MISSING" });
      const body = await readRequestBody(request);
      const baseDraft = isRecord(body.draft) ? body.draft : {};
      const removedInbound = new Set(Array.isArray(baseDraft.removeIncoming) ? baseDraft.removeIncoming : []);
      const draftInbound = Array.isArray(baseDraft.incoming) ? baseDraft.incoming : [];
      const usableInbound = instance.inbound.find((entry) => entry.token && !removedInbound.has(entry.name)) || draftInbound.find((entry) => entry?.token);
      if (!usableInbound && !body.connectionName) {
        sendJson(response, 200, { connectionRequired: true, suggestedToken: createToken() });
        return;
      }
      const incoming = !usableInbound ? [...draftInbound, { name: body.connectionName, token: body.token || createToken() }] : draftInbound;
      const draft = {
        ...baseDraft,
        server: { ...(isRecord(baseDraft.server) ? baseDraft.server : {}), enabled: true },
        workspaceConfig: isRecord(baseDraft.workspaceConfig) ? baseDraft.workspaceConfig : instance.workspaceConfig,
        ...(incoming.length ? { incoming } : {}),
      };
      sendJson(response, 200, { connectionRequired: false, ...createPreview(instance.workspace, draft) });
      return;
    }
    if (pathname.startsWith("/api/instances/") && request.method === "GET") {
      const instance = instanceByKey(pathname.split("/").at(-1));
      if (!instance) {
        sendError(response, 404, "NOT_FOUND", "实例不存在");
        return;
      }
      sendJson(response, 200, instance);
      return;
    }
    if (pathname === "/api/connections/validate" && request.method === "POST") {
      sendJson(response, 200, await verifyConnection(await readRequestBody(request)));
      return;
    }
    if (pathname === "/api/config/preview" && request.method === "POST") {
      const body = await readRequestBody(request);
      sendJson(response, 200, createPreview(body.workspace, isRecord(body.draft) ? body.draft : {}));
      return;
    }
    if (pathname === "/api/config/apply" && request.method === "POST") {
      const body = await readRequestBody(request);
      sendJson(response, 200, applyPreview(body.previewId));
      return;
    }
    if (pathname === "/api/fs/directories" && request.method === "GET") {
      const path = normalizeWorkspacePath(url.searchParams.get("path") || process.cwd());
      sendJson(response, 200, { path, entries: readDirectories(path) });
      return;
    }
    if (pathname.startsWith("/api/")) {
      sendError(response, 404, "NOT_FOUND", "接口不存在");
      return;
    }
    if (request.method === "GET") {
      const relativePath = normalize(pathname).replace(/^\/+/, "");
      if (relativePath.startsWith("..") || relativePath.includes(`${sep}..${sep}`)) {
        sendError(response, 404, "NOT_FOUND", "页面不存在");
        return;
      }
      serveFile(response, join(STATIC_ROOT, relativePath || "index.html"));
      return;
    }
    sendError(response, 405, "METHOD_NOT_ALLOWED", "不支持的请求方法");
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendError(response, error.status || 400, error.code || "REQUEST_FAILED", error instanceof Error ? error.message : String(error), error.details);
  }
});

export function startServer() {
  if (SERVER_HOST !== "127.0.0.1" && SERVER_HOST !== "::1" && !ADMIN_TOKEN) {
    throw new Error("非 loopback 管理页面必须设置 A2A_CONFIG_ADMIN_TOKEN");
  }
  httpServer.listen(SERVER_PORT, SERVER_HOST, () => {
    const address = httpServer.address();
    appLoopbackUrl = `http://127.0.0.1:${address.port}`;
    runtimeDescriptorInstances = readManagedInstances().filter((instance) => !instance.error);
    writeRuntimeDescriptors(runtimeDescriptorInstances, appLoopbackUrl);
    fileTransferManager.restore();
    console.log(`A2A Config: http://${SERVER_HOST}:${address.port}/`);
  });
  return httpServer;
}

export async function stopServer() {
  await fileTransferManager.stopAll();
  removeRuntimeDescriptors(runtimeDescriptorInstances);
  await new Promise((resolveStop) => httpServer.close(resolveStop));
}

export { applyPreview, createPreview, fileTransferManager, httpServer, statePayload, BASE_PATH, joinBasePath, normalizeBasePath, stripBasePath };

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  startServer();
  const shutdown = async () => {
    await stopServer();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
