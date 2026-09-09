import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(ROOT, "..");
const STATIC_ROOT = join(APP_ROOT, "web");
const DEFAULT_AGENT_DIR = join(homedir(), ".pi", "agent");
const STATE_ROOT = process.platform === "darwin"
  ? join(homedir(), "Library", "Application Support", "a2a-config")
  : join(homedir(), ".config", "a2a-config");
const STATE_FILE = join(STATE_ROOT, "state.json");
const SESSION_TOKEN = randomBytes(32).toString("hex");
const previews = new Map();

function json(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders });
  res.end(text);
}

function fail(res, status, code, message, details) {
  json(res, status, { error: { code, message, ...(details ? { details } : {}) } });
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function hashText(text) { return createHash("sha256").update(text).digest("hex"); }
function hashPath(path) { return hashText(path).slice(0, 16); }
function isRecord(value) { return value && typeof value === "object" && !Array.isArray(value); }
function clone(value) { return structuredClone(value); }
function ensureObject(value) { return isRecord(value) ? value : {}; }
function safeJsonRead(path) {
  try {
    const text = readFileSync(path, "utf8");
    const value = JSON.parse(text);
    if (!isRecord(value)) throw new Error("settings.json must contain an object");
    return { value, text, hash: hashText(text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function stateRead() {
  try {
    const value = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return Array.isArray(value.manualAgentDirs) ? value.manualAgentDirs.filter((item) => typeof item === "string") : [];
  } catch { return []; }
}

function stateWrite(paths) {
  mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  const temp = `${STATE_FILE}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, manualAgentDirs: paths }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, STATE_FILE);
}

function normalizeAgentDir(input) {
  const candidate = resolve(String(input || ""));
  if (!existsSync(candidate)) throw new Error("目录不存在");
  if (!statSync(candidate).isDirectory()) throw new Error("路径不是目录");
  const real = realpathSync(candidate);
  const settingsPath = join(real, "settings.json");
  if (!existsSync(settingsPath)) throw new Error("目录中缺少 settings.json");
  const settings = safeJsonRead(settingsPath);
  if (settings.error) throw new Error(`settings.json 无法解析：${settings.error}`);
  return real;
}

function readEnvFile(agentDir) {
  const path = join(agentDir, ".env.local");
  try { return { path, text: readFileSync(path, "utf8"), hash: hashText(readFileSync(path)) }; }
  catch { return { path, text: "", hash: null }; }
}

function fileMode(path, fallback) { try { return statSync(path).mode & 0o777; } catch { return fallback; } }

function envValue(text, name) {
  const lines = text.split(/\r?\n/);
  const matches = lines.filter((line) => line.trim().startsWith(`${name}=`));
  if (matches.length > 1) throw new Error(`环境变量 ${name} 重复`);
  if (matches.length === 0) return undefined;
  const raw = matches[0].slice(name.length + 1).trim();
  const unquoted = ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) ? raw.slice(1, -1) : raw;
  try { return JSON.parse(unquoted); } catch { throw new Error(`${name} 不是有效 JSON`); }
}

function secretName(instanceId) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(instanceId)) throw new Error("instanceId 必须以小写字母开头，只能包含小写字母、数字和连字符");
  return `PI_A2A_${instanceId.toUpperCase().replaceAll("-", "_")}`;
}

function parseProfiles(a2a) {
  const profiles = ensureObject(a2a.profiles);
  return Object.entries(profiles).map(([cwd, profile]) => ({ cwd, profile: ensureObject(profile) }));
}

function hasA2aExtension(settings, agentDir) {
  const sources = [...(Array.isArray(settings.packages) ? settings.packages : []), ...(Array.isArray(settings.extensions) ? settings.extensions : [])];
  const text = JSON.stringify(sources);
  const installed = /zhangst_a2a-pi|@zhangst\/pi-a2a|pi-a2a/i.test(text);
  return { installed, source: installed ? sources.find((item) => /a2a/i.test(JSON.stringify(item))) : undefined };
}

function findPiInstallations() {
  const found = [];
  const seen = new Set();
  const add = (path, source) => {
    if (!path || seen.has(path) || !existsSync(path)) return;
    try {
      const real = realpathSync(path);
      if (seen.has(real)) return;
      seen.add(real);
      let version;
      try { version = execFileSync(real, ["--version"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
      found.push({ executablePath: path, realPath: real, version, source });
    } catch {}
  };
  for (const directory of String(process.env.PATH || "").split(sep)) add(join(directory, process.platform === "win32" ? "pi.cmd" : "pi"), "path");
  add(join(homedir(), ".npm-global", "bin", "pi"), "npm");
  add(join(homedir(), ".bun", "bin", "pi"), "bun");
  const commands = [["npm", ["root", "-g"], "npm"], ["pnpm", ["root", "-g"], "pnpm"], ["bun", ["pm", "bin", "-g"], "bun"]];
  for (const [command, args, source] of commands) {
    try {
      const root = execFileSync(command, args, { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim();
      add(join(root, "@earendil-works", "pi-coding-agent", "dist", "cli.js"), source);
      add(join(root, "pi-coding-agent", "dist", "cli.js"), source);
    } catch {}
  }
  return found;
}

function detectRunningPiProcesses() {
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  const result = [];
  try {
    const listing = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] });
    for (const line of listing.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match || !/(?:^|[ /])pi(?:\.js|\.mjs|\.cjs)?(?:\s|$)|pi-coding-agent/.test(match[2])) continue;
      const pid = Number(match[1]);
      let cwd;
      try {
        const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
        cwd = output.split(/\r?\n/).find((entry) => entry.startsWith("n"))?.slice(1);
      } catch {}
      result.push({ pid, command: match[2].slice(0, 500), cwd: cwd || null });
    }
  } catch {}
  return result;
}

function listRegistry(agentDir) {
  const registryDir = join(agentDir, "a2a_registry");
  if (!existsSync(registryDir)) return [];
  const now = Date.now();
  const output = [];
  for (const name of readDirSafe(registryDir)) {
    if (!/^\d+\.json$/.test(name)) continue;
    const path = join(registryDir, name);
    try {
      const descriptor = JSON.parse(readFileSync(path, "utf8"));
      const mtime = statSync(path).mtimeMs;
      if (now - mtime > 60_000) continue;
      output.push({ ...descriptor, pid: Number(descriptor.pid), registryPath: path });
    } catch {}
  }
  return output;
}

function readDirSafe(path) { try { return readdirSync(path); } catch { return []; } }
function directoryEntries(path) { return readDirSafe(path); }

function effectiveInstance(agentDir, cwd) {
  const settingsPath = join(agentDir, "settings.json");
  const loaded = safeJsonRead(settingsPath);
  if (loaded.error) throw new Error(loaded.error);
  const a2a = ensureObject(loaded.value.a2a);
  const globalA2a = clone(a2a);
  delete globalA2a.profiles;
  const profile = ensureObject(ensureObject(a2a.profiles)[cwd]);
  const merged = deepMerge(globalA2a, profile);
  const instanceId = typeof merged.instanceId === "string" ? merged.instanceId : "pi-main";
  const secret = envValue(readEnvFile(agentDir).text, secretName(instanceId)) ?? {};
  const server = ensureObject(merged.server);
  const workspaceId = typeof server.defaultWorkspaceId === "string" && server.defaultWorkspaceId ? server.defaultWorkspaceId : basenameSafe(cwd);
  const workspaces = ensureObject(merged.workspaces);
  const workspace = ensureObject(workspaces[workspaceId]);
  const peers = ensureObject(merged.peers);
  const inboundPeers = ensureObject(merged.inboundPeers);
  return {
    key: hashPath(`${agentDir}\0${cwd}`),
    agentDir,
    cwd,
    settingsPath,
    envPath: join(agentDir, ".env.local"),
    settingsHash: loaded.hash,
    envHash: readEnvFile(agentDir).hash,
    instanceId,
    agentName: typeof server.agentName === "string" && server.agentName ? server.agentName : instanceId,
    server: {
      enabled: server.enabled === true,
      host: typeof server.host === "string" ? server.host : "127.0.0.1",
      port: numberOr(server.port, 9910),
      portFallback: numberOr(server.portFallback, 10),
      publicUrl: typeof server.publicUrl === "string" ? server.publicUrl : "",
    },
    workspace: { id: workspaceId, root: typeof workspace.root === "string" ? workspace.root : cwd },
    peers: Object.entries(peers).map(([name, value]) => ({ name, value: ensureObject(value), token: ensureObject(secret.outbound).peers?.[name]?.token ?? "" })),
    inbound: Object.entries(inboundPeers).map(([name, value]) => ({ name, value: ensureObject(value), token: ensureObject(secret.server).peerTokens?.[name] ?? "" })),
    plugin: hasA2aExtension(loaded.value, agentDir),
    registry: listRegistry(agentDir).filter((item) => item.cwd === cwd),
  };
}

function basenameSafe(path) { return path.split(/[\\/]/).filter(Boolean).pop() || "default"; }
function numberOr(value, fallback) { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function deepMerge(base, overlay) {
  const result = clone(base);
  for (const [key, value] of Object.entries(overlay)) result[key] = isRecord(value) && isRecord(result[key]) ? deepMerge(result[key], value) : clone(value);
  return result;
}

function collectDirectories() {
  const raw = [DEFAULT_AGENT_DIR, ...stateRead()];
  const byPath = new Map();
  for (const item of raw) {
    let real;
    try { real = normalizeAgentDir(item); } catch { real = resolve(item); }
    if (byPath.has(real)) continue;
    const settings = safeJsonRead(join(real, "settings.json"));
    const valid = !settings.error;
    const a2a = valid ? ensureObject(settings.value.a2a) : {};
    const profiles = valid ? parseProfiles(a2a) : [];
    const instances = [];
    for (const { cwd } of profiles) {
      try { instances.push(effectiveInstance(real, cwd)); } catch {}
    }
    if (valid && instances.length === 0 && existsSync(real)) {
      const globalA2a = ensureObject(a2a);
      const globalInstanceId = typeof globalA2a.instanceId === "string" ? globalA2a.instanceId : "pi-main";
      instances.push({
        key: hashPath(`${real}\\0__global__`), agentDir: real, cwd: real,
        settingsPath: join(real, "settings.json"), envPath: join(real, ".env.local"),
        settingsHash: settings.hash, envHash: readEnvFile(real).hash,
        instanceId: globalInstanceId, agentName: globalInstanceId,
        server: { enabled: false, host: "127.0.0.1", port: 9910, portFallback: 10, publicUrl: "" },
        workspace: { id: "", root: real }, peers: [], inbound: [],
        plugin: hasA2aExtension(settings.value, real), registry: [], globalOnly: true,
      });
    }
    byPath.set(real, {
      key: hashPath(real), path: item, realPath: existsSync(real) ? real : null,
      valid, error: settings.error, settingsPath: join(real, "settings.json"), envPath: join(real, ".env.local"),
      sources: item === DEFAULT_AGENT_DIR ? ["default"] : ["manual"],
      extension: valid ? hasA2aExtension(settings.value, real) : { installed: false },
      installations: findPiInstallations(), instances,
      registry: listRegistry(real),
      runningProcesses: detectRunningPiProcesses().filter((process) => process.cwd && process.cwd.startsWith(real)),
    });
  }
  return [...byPath.values()];
}

function parseCookie(req, name) {
  const header = String(req.headers.cookie || "");
  const match = header.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function authenticated(req, res) {
  const token = parseCookie(req, "a2a_config_session");
  if (token !== SESSION_TOKEN) { fail(res, 401, "UNAUTHORIZED", "本地会话已失效，请重新打开工具"); return false; }
  if (req.method !== "GET" && req.headers.origin) {
    const origin = String(req.headers.origin);
    const expected = new Set([`http://${req.headers.host}`, `https://${req.headers.host}`]);
    if (!expected.has(origin)) { fail(res, 403, "BAD_ORIGIN", "请求来源不匹配"); return false; }
  }
  return true;
}

function setAt(root, path, value) {
  let cursor = root;
  for (const segment of path.slice(0, -1)) { if (!isRecord(cursor[segment])) cursor[segment] = {}; cursor = cursor[segment]; }
  cursor[path.at(-1)] = value;
}
function deleteAt(root, path) {
  let cursor = root;
  for (const segment of path.slice(0, -1)) { if (!isRecord(cursor[segment])) return; cursor = cursor[segment]; }
  delete cursor[path.at(-1)];
}

function applySettingsDraft(settings, cwd, draft) {
  const next = clone(settings);
  if (!isRecord(next.a2a)) next.a2a = {};
  if (!isRecord(next.a2a.profiles)) next.a2a.profiles = {};
  const profile = ensureObject(next.a2a.profiles[cwd]);
  next.a2a.profiles[cwd] = profile;
  const server = ensureObject(profile.server);
  profile.server = server;
  for (const key of ["enabled", "host", "port", "portFallback", "agentName", "publicUrl", "defaultWorkspaceId"]) {
    if (draft.server?.[key] !== undefined) {
      if (draft.server[key] === "" && key === "publicUrl") delete server[key]; else server[key] = draft.server[key];
    }
  }
  if (draft.instanceId !== undefined) profile.instanceId = draft.instanceId;
  const workspaceId = draft.workspace?.id;
  if (workspaceId) {
    profile.server.defaultWorkspaceId = workspaceId;
    profile.workspaces = ensureObject(profile.workspaces);
    const existing = ensureObject(profile.workspaces[workspaceId]);
    profile.workspaces[workspaceId] = { ...existing, root: draft.workspace.root, allowedPeers: Array.isArray(existing.allowedPeers) ? existing.allowedPeers : [], allowedAgents: Array.isArray(existing.allowedAgents) ? existing.allowedAgents : ["coding"] };
  }
  if (draft.outgoing) {
    const outgoingTarget = draft.outgoingScope === "global" ? next.a2a : profile;
    outgoingTarget.peers = ensureObject(outgoingTarget.peers);
    for (const connection of draft.outgoing) outgoingTarget.peers[connection.name] = { ...ensureObject(outgoingTarget.peers[connection.name]), url: connection.url, ...(connection.timeoutMs ? { timeoutMs: connection.timeoutMs } : {}) };
  }
  if (draft.incoming) {
    profile.inboundPeers = ensureObject(profile.inboundPeers);
    for (const connection of draft.incoming) profile.inboundPeers[connection.name] = { ...ensureObject(profile.inboundPeers[connection.name]), scopes: ["message:send", "task:read"], allowedWorkspaces: [], allowedAgents: ["coding"], allowedTools: ["read", "grep", "find", "ls", "write", "edit", "bash"] };
    const workspace = ensureObject(profile.workspaces?.[workspaceId]);
    workspace.allowedPeers = [...new Set([...(Array.isArray(workspace.allowedPeers) ? workspace.allowedPeers : []), ...draft.incoming.map((item) => item.name)])];
    profile.workspaces[workspaceId] = workspace;
  }
  if (draft.removeIncoming?.length) {
    profile.inboundPeers = ensureObject(profile.inboundPeers);
    profile.workspaces = ensureObject(profile.workspaces);
    for (const name of draft.removeIncoming) {
      delete profile.inboundPeers[name];
      for (const workspace of Object.values(profile.workspaces)) if (isRecord(workspace) && Array.isArray(workspace.allowedPeers)) workspace.allowedPeers = workspace.allowedPeers.filter((item) => item !== name);
    }
  }
  if (draft.removeOutgoing?.length) {
    profile.peers = ensureObject(profile.peers);
    for (const name of draft.removeOutgoing) delete profile.peers[name];
  }
  return next;
}

function updateSecretText(text, instanceId, update) {
  const name = secretName(instanceId);
  const lines = text.split(/\r?\n/);
  const indexes = lines.map((line, index) => line.trim().startsWith(`${name}=`) ? index : -1).filter((index) => index >= 0);
  if (indexes.length > 1) throw new Error(`环境变量 ${name} 重复`);
  const current = indexes.length ? envValue(text, name) : {};
  const next = mergeSecret(current ?? {}, update);
  const line = `${name}='${JSON.stringify(next)}'`;
  if (indexes.length) lines[indexes[0]] = line; else lines.push(line);
  return `${lines.filter((line, index) => index < lines.length - 1 || line !== "").join("\n").replace(/\n+$/, "")}\n`;
}

function renameSecretText(text, fromInstanceId, toInstanceId) {
  if (fromInstanceId === toInstanceId) return text;
  const fromName = secretName(fromInstanceId);
  const toName = secretName(toInstanceId);
  const lines = text.split(/\r?\n/);
  const fromIndexes = lines.map((line, index) => line.trim().startsWith(`${fromName}=`) ? index : -1).filter((index) => index >= 0);
  const toIndexes = lines.map((line, index) => line.trim().startsWith(`${toName}=`) ? index : -1).filter((index) => index >= 0);
  if (fromIndexes.length > 1 || toIndexes.length > 1) throw new Error("A2A secret 环境变量重复");
  if (toIndexes.length) throw new Error(`${toName} 已存在，不能迁移 instanceId`);
  if (!fromIndexes.length) return text;
  lines[fromIndexes[0]] = lines[fromIndexes[0]].replace(fromName, toName);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function acquireLocks(paths) {
  const locks = [];
  try {
    for (const path of [...paths].sort()) {
      const lockPath = `${path}.a2a-config.lock`;
      const fd = openSync(lockPath, "wx", 0o600);
      locks.push({ fd, lockPath });
    }
    return () => {
      for (const lock of locks.reverse()) {
        try { closeSync(lock.fd); } catch {}
        try { unlinkSync(lock.lockPath); } catch {}
      }
    };
  } catch (error) {
    for (const lock of locks.reverse()) {
      try { closeSync(lock.fd); } catch {}
      try { unlinkSync(lock.lockPath); } catch {}
    }
    throw new Error(`配置正在被其他进程修改：${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeAtomically(path, content, mode) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { mode });
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

function mergeSecret(base, overlay) {
  const result = clone(base);
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) {
      delete result[key];
    } else if (isRecord(value)) {
      result[key] = mergeSecret(isRecord(result[key]) ? result[key] : {}, value);
      if (isRecord(result[key]) && Object.keys(result[key]).length === 0) delete result[key];
    } else {
      result[key] = clone(value);
    }
  }
  return result;
}

function secretUpdateFromDraft(instance, draft) {
  const update = {};
  if (draft.outgoing?.length) update.outbound = { peers: Object.fromEntries(draft.outgoing.map((item) => [item.name, { token: item.token }])) };
  if (draft.incoming?.length) update.server = { peerTokens: Object.fromEntries(draft.incoming.map((item) => [item.name, item.token])) };
  if (draft.removeIncoming?.length) update.server = { ...(update.server || {}), peerTokens: Object.fromEntries(draft.removeIncoming.map((name) => [name, null])) };
  if (draft.removeOutgoing?.length) update.outbound = { ...(update.outbound || {}), peers: Object.fromEntries(draft.removeOutgoing.map((name) => [name, null])) };
  return Object.keys(update).length ? update : null;
}

async function verifyConnection(input) {
  const base = String(input.url || "").replace(/\/+$/, "");
  let parsedBase;
  try { parsedBase = new URL(base); } catch { throw new Error("A2A URL 无效"); }
  if (!['http:', 'https:'].includes(parsedBase.protocol)) throw new Error("A2A URL 只支持 http/https");
  if (parsedBase.username || parsedBase.password) throw new Error("A2A URL 不能包含用户名或密码");
  let cardResponse = await fetch(`${base}/.well-known/agent-card.json`, { headers: input.token ? { authorization: `Bearer ${input.token}` } : {}, signal: AbortSignal.timeout(5000) });
  if (cardResponse.status === 404) cardResponse = await fetch(`${base}/.well-known/agent.json`, { headers: input.token ? { authorization: `Bearer ${input.token}` } : {}, signal: AbortSignal.timeout(5000) });
  if (!cardResponse.ok) throw new Error(`Agent Card HTTP ${cardResponse.status}`);
  const card = await cardResponse.json();
  const endpoint = card.supportedInterfaces?.find((item) => item.protocolBinding === "JSONRPC")?.url || card.url || base;
  const endpointUrl = new URL(endpoint, base);
  if (endpointUrl.origin !== parsedBase.origin) throw new Error("Agent Card endpoint 必须与输入 URL 同源");
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/a2a+json", ...(input.token ? { authorization: `Bearer ${input.token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "GetTask", params: { id: `a2a-config-probe-${randomUUID()}` } }), signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  const isExpected = result.error?.code === -32001 || result.error?.message?.toLowerCase().includes("not found");
  if (!response.ok && !isExpected) throw new Error(`验证请求 HTTP ${response.status}`);
  if (result.error && !isExpected) throw new Error(result.error.message || "连接验证失败");
  return { name: card.name || "未命名 Pi", skills: Array.isArray(card.skills) ? card.skills.map((item) => item.name || item.id).filter(Boolean) : [], endpoint };
}

function responseFile(res, path) {
  const ext = extname(path);
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  try { res.writeHead(200, { "content-type": types[ext] || "application/octet-stream", "cache-control": "no-cache" }); res.end(readFileSync(path)); }
  catch { fail(res, 404, "NOT_FOUND", "页面不存在"); }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/" && req.method === "GET") {
    res.setHeader("set-cookie", `a2a_config_session=${SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
    return responseFile(res, join(STATIC_ROOT, "index.html"));
  }
  if (url.pathname.startsWith("/api/") && !authenticated(req, res)) return;
  try {
    if (url.pathname === "/api/state" && req.method === "GET") return json(res, 200, { directories: collectDirectories(), defaultAgentDir: DEFAULT_AGENT_DIR });
    if (url.pathname === "/api/agent-dirs" && req.method === "GET") return json(res, 200, { directories: collectDirectories(), defaultAgentDir: DEFAULT_AGENT_DIR });
    if (url.pathname === "/api/agent-dirs/validate" && req.method === "POST") {
      const body = await readBody(req); const realPath = normalizeAgentDir(body.path); const settings = safeJsonRead(join(realPath, "settings.json")); return json(res, 200, { realPath, piVersion: "unknown", profiles: parseProfiles(ensureObject(settings.value.a2a)).length, extension: hasA2aExtension(settings.value, realPath) });
    }
    if (url.pathname === "/api/agent-dirs" && req.method === "POST") {
      const body = await readBody(req); const realPath = normalizeAgentDir(body.path); const paths = [...new Set([...stateRead(), realPath])]; stateWrite(paths); return json(res, 200, { path: realPath });
    }
    if (url.pathname === "/api/instances" && req.method === "POST") {
      const body = await readBody(req);
      const agentDir = normalizeAgentDir(body.agentDir);
      const cwd = resolve(String(body.cwd || ""));
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return fail(res, 400, "INVALID_DIRECTORY", "工作目录不存在");
      const settingsPath = join(agentDir, "settings.json");
      const loaded = safeJsonRead(settingsPath);
      const settings = loaded.value;
      if (!isRecord(settings.a2a)) settings.a2a = {};
      if (!isRecord(settings.a2a.profiles)) settings.a2a.profiles = {};
      if (settings.a2a.profiles[cwd]) return fail(res, 409, "PROFILE_EXISTS", "该工作目录已经存在 profile");
      const instanceId = typeof body.instanceId === "string" && body.instanceId ? body.instanceId : basenameSafe(cwd);
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(instanceId)) return fail(res, 400, "INVALID_INSTANCE_ID", "instanceId 格式无效");
      const workspaceId = typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : basenameSafe(cwd);
      settings.a2a.profiles[cwd] = { instanceId, server: { enabled: false, host: "127.0.0.1", port: 9910, portFallback: 10, agentName: instanceId, defaultWorkspaceId: workspaceId }, workspaces: { [workspaceId]: { root: cwd, allowedPeers: [], allowedAgents: ["coding"] } } };
      const temp = `${settingsPath}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, settingsPath);
      return json(res, 201, { instance: effectiveInstance(agentDir, cwd), reloadRequired: true });
    }
    if (url.pathname === "/api/ports/check" && req.method === "POST") {
      const body = await readBody(req);
      const host = typeof body.host === "string" && body.host ? body.host : "127.0.0.1";
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(res, 400, "INVALID_PORT", "端口必须是 1 到 65535 的整数");
      const probe = createServer();
      const available = await new Promise((resolveProbe) => {
        probe.once("error", () => resolveProbe(false));
        probe.listen(port, host, () => probe.close(() => resolveProbe(true)));
      });
      return json(res, 200, { host, port, available });
    }
    if (url.pathname.startsWith("/api/agent-dirs/") && req.method === "DELETE") {
      const key = url.pathname.split("/").at(-1); const dirs = collectDirectories().find((item) => item.key === key); if (!dirs) return fail(res, 404, "NOT_FOUND", "配置目录不存在"); stateWrite(stateRead().filter((item) => resolve(item) !== dirs.realPath)); return json(res, 200, { ok: true });
    }
    if ((url.pathname === "/api/instance" || url.pathname === "/api/instances/detail") && req.method === "GET") {
      const agentDir = normalizeAgentDir(url.searchParams.get("agentDir")); const cwd = realpathSync(resolve(url.searchParams.get("cwd") || agentDir)); return json(res, 200, effectiveInstance(agentDir, cwd));
    }
    if (url.pathname === "/api/instances" && req.method === "GET") {
      const agentDir = normalizeAgentDir(url.searchParams.get("agentDir"));
      const settings = safeJsonRead(join(agentDir, "settings.json"));
      if (settings.error) return fail(res, 400, "INVALID_SETTINGS", settings.error);
      return json(res, 200, parseProfiles(ensureObject(settings.value.a2a)).map(({ cwd }) => effectiveInstance(agentDir, cwd)));
    }
    if (url.pathname.startsWith("/api/instances/") && req.method === "GET") {
      const key = url.pathname.split("/").at(-1);
      const instance = collectDirectories().flatMap((directory) => directory.instances || []).find((item) => item.key === key);
      if (!instance) return fail(res, 404, "NOT_FOUND", "实例不存在");
      return json(res, 200, instance);
    }
    if (url.pathname === "/api/fs/directories" && req.method === "GET") {
      const requested = resolve(url.searchParams.get("path") || homedir()); if (!existsSync(requested) || !statSync(requested).isDirectory()) return fail(res, 400, "INVALID_DIRECTORY", "目录不存在"); const entries = directoryEntries(requested).filter((name) => !name.startsWith(".")); return json(res, 200, { path: requested, entries: entries.filter((name) => { try { return statSync(join(requested, name)).isDirectory(); } catch { return false; } }).slice(0, 200) });
    }
    if (url.pathname === "/api/connections/validate" && req.method === "POST") return json(res, 200, await verifyConnection(await readBody(req)));
    if (url.pathname === "/api/config/preview" && req.method === "POST") {
      const body = await readBody(req); const agentDir = normalizeAgentDir(body.agentDir); const cwd = realpathSync(resolve(body.cwd)); const settingsPath = join(agentDir, "settings.json"); const env = readEnvFile(agentDir); const settings = safeJsonRead(settingsPath); const nextSettings = applySettingsDraft(settings.value, cwd, body.draft || {}); const instance = effectiveInstance(agentDir, cwd); const instanceId = body.draft?.instanceId || instance.instanceId; const secretUpdate = secretUpdateFromDraft(instance, body.draft || {}); let nextEnv = instanceId !== instance.instanceId ? renameSecretText(env.text, instance.instanceId, instanceId) : env.text; if (secretUpdate) nextEnv = updateSecretText(nextEnv, instanceId, secretUpdate); const previewId = randomUUID(); const item = { previewId, agentDir, cwd, settingsHash: settings.hash, envHash: env.hash, nextSettings, nextEnv, settingsText: `${JSON.stringify(nextSettings, null, 2)}\n`, draft: body.draft || {} }; previews.set(previewId, item); setTimeout(() => previews.delete(previewId), 300_000).unref(); return json(res, 200, { previewId, baseHashes: { settings: settings.hash, env: env.hash }, settingsDiff: `${settings.text}\n---\n${item.settingsText}`, envDiff: nextEnv !== env.text ? `${env.text}\n---\n${nextEnv}` : "无 secret 修改" });
    }
    if (url.pathname === "/api/config/apply" && req.method === "POST") {
      const body = await readBody(req); const item = previews.get(body.previewId); if (!item) return fail(res, 409, "PREVIEW_EXPIRED", "预览已失效，请重新生成"); const settingsPath = join(item.agentDir, "settings.json"); const envPath = join(item.agentDir, ".env.local"); const releaseLocks = acquireLocks([settingsPath, envPath]); try { const settings = safeJsonRead(settingsPath); const env = readEnvFile(item.agentDir); if (settings.hash !== item.settingsHash || env.hash !== item.envHash) return fail(res, 409, "CONFIG_CHANGED", "Pi 配置在预览后发生变化，请刷新后重试"); const previousSettings = settings.text; const previousEnv = env.text; try { writeAtomically(envPath, item.nextEnv, fileMode(envPath, 0o600)); writeAtomically(settingsPath, item.settingsText, fileMode(settingsPath, 0o600)); } catch (error) { try { writeAtomically(envPath, previousEnv, fileMode(envPath, 0o600)); writeAtomically(settingsPath, previousSettings, fileMode(settingsPath, 0o600)); } catch (rollbackError) { return fail(res, 500, "ROLLBACK_FAILED", "保存失败，且配置回滚失败", { save: String(error), rollback: String(rollbackError) }); } return fail(res, 500, "SAVE_FAILED", "保存失败，原配置已恢复", String(error)); } previews.delete(body.previewId); return json(res, 200, { ok: true, reloadRequired: true }); } finally { releaseLocks(); }
    }
    if (url.pathname.startsWith("/api/")) return fail(res, 404, "NOT_FOUND", "接口不存在");
    if (req.method === "GET") {
      const relativePath = normalize(url.pathname).replace(/^\/+/, "");
      if (relativePath.startsWith("..") || relativePath.includes(`${sep}..${sep}`)) return fail(res, 404, "NOT_FOUND", "页面不存在");
      return responseFile(res, join(STATIC_ROOT, relativePath || "index.html"));
    }
    return fail(res, 405, "METHOD_NOT_ALLOWED", "不支持的请求方法");
  } catch (error) {
    if (!res.headersSent) fail(res, 400, "REQUEST_FAILED", error instanceof Error ? error.message : String(error));
    else res.destroy();
  }
});

function startServer() {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    console.log(`A2A Config: http://127.0.0.1:${address.port}/`);
  });
}

export { applySettingsDraft, collectDirectories, effectiveInstance, envValue, normalizeAgentDir, renameSecretText, secretName, startServer, updateSecretText };

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  startServer();
}
