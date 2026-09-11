import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const BASE_PORT = 9910;
export const DEFAULT_HOST = "0.0.0.0";
export const PORT_FALLBACK = 10;
export const DEFAULT_AGENT_DIR = process.env.A2A_CONFIG_AGENT_DIR || join(homedir(), ".pi", "agent");
export const STATE_FILE = process.env.A2A_CONFIG_STATE_FILE || (
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "a2a-config", "state.json")
    : join(homedir(), ".config", "a2a-config", "state.json")
);

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function workspaceKey(workspacePath) {
  return hashText(workspacePath).slice(0, 16);
}

export function instanceKey(agentDir, workspacePath) {
  return hashText(`${resolve(agentDir)}\0${resolve(workspacePath)}`).slice(0, 16);
}

export function normalizeWorkspacePath(input) {
  const candidate = resolve(String(input || ""));
  if (!existsSync(candidate)) throw new Error("工作目录不存在");
  if (!statSync(candidate).isDirectory()) throw new Error("路径不是目录");
  return realpathSync(candidate);
}

export function pathsForWorkspace(workspacePath, agentDirInput = DEFAULT_AGENT_DIR) {
  const workspace = normalizeWorkspacePath(workspacePath);
  const projectDir = join(workspace, ".pi");
  const agentDir = resolve(agentDirInput);
  return {
    workspace,
    projectDir,
    projectSettingsPath: join(projectDir, "settings.json"),
    agentDir,
    settingsPath: join(agentDir, "settings.json"),
    envPath: join(agentDir, ".env.local"),
    registryDir: join(agentDir, "a2a_registry"),
  };
}

export function readJsonFile(path, { required = false } = {}) {
  if (!existsSync(path)) {
    if (required) throw new Error(`${path} 不存在`);
    return { exists: false, value: {}, text: "", hash: null };
  }
  const text = readFileSync(path, "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(`${path} 必须包含 JSON object`);
  return { exists: true, value, text, hash: hashText(text) };
}

export function readState(path = STATE_FILE) {
  return [DEFAULT_AGENT_DIR, ...readAppState(path).manualAgentDirs].filter((entry, index, values) => values.indexOf(entry) === index);
}

export function readAppState(path = STATE_FILE) {
  if (!existsSync(path)) return { version: 4, manualAgentDirs: [], legacyWorkspaces: [], migratedLegacyWorkspaces: [], fileWorkspaces: [] };
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`A2A Config 状态文件不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error("A2A Config 状态文件必须包含 JSON object");
  return {
    version: 4,
    manualAgentDirs: Array.isArray(value.manualAgentDirs) ? value.manualAgentDirs.filter((entry) => typeof entry === "string") : [],
    legacyWorkspaces: [
      ...(Array.isArray(value.legacyWorkspaces) ? value.legacyWorkspaces : []),
      ...(Array.isArray(value.workspaces) ? value.workspaces : []),
    ].filter((entry) => typeof entry === "string"),
    migratedLegacyWorkspaces: Array.isArray(value.migratedLegacyWorkspaces) ? value.migratedLegacyWorkspaces.filter((entry) => typeof entry === "string") : [],
    fileWorkspaces: Array.isArray(value.fileWorkspaces) ? value.fileWorkspaces.filter(isRecord) : [],
  };
}

export function writeAppState(state, path = STATE_FILE) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeAtomically(path, `${JSON.stringify({
    version: 4,
    manualAgentDirs: [...new Set(state.manualAgentDirs || [])],
    legacyWorkspaces: [...new Set(state.legacyWorkspaces || [])],
    migratedLegacyWorkspaces: [...new Set(state.migratedLegacyWorkspaces || [])],
    fileWorkspaces: Array.isArray(state.fileWorkspaces) ? state.fileWorkspaces : [],
  }, null, 2)}\n`, 0o600);
}

export function updateAppState(update, path = STATE_FILE) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = acquireLocks([path]);
  try {
    const current = readAppState(path);
    const next = update(structuredClone(current));
    writeAppState(next, path);
    return next;
  } finally {
    release();
  }
}

export function addAgentDirToState(agentDir, path = STATE_FILE) {
  const normalized = realpathSync(resolve(agentDir));
  updateAppState((state) => ({ ...state, manualAgentDirs: [...new Set([...state.manualAgentDirs, normalized])] }), path);
  return normalized;
}

export function removeAgentDirFromState(agentDir, path = STATE_FILE) {
  const normalized = resolve(agentDir);
  updateAppState((state) => ({ ...state, manualAgentDirs: state.manualAgentDirs.filter((entry) => resolve(entry) !== normalized) }), path);
}

export function normalizeInstanceId(folderName, workspacePath, usedIds = new Set()) {
  let candidate = folderName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
  if (!candidate || !/^[a-z]/.test(candidate)) candidate = `pi-${hashText(workspacePath).slice(0, 8)}`;
  if (!usedIds.has(candidate)) return candidate;
  const suffix = `-${hashText(workspacePath).slice(0, 6)}`;
  return `${candidate.slice(0, 63 - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

export function secretName(instanceId) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(instanceId)) {
    throw new Error("instanceId 必须以小写字母开头，只能包含小写字母、数字和连字符");
  }
  return `PI_A2A_${instanceId.toUpperCase().replaceAll("-", "_")}`;
}

export function envValue(text, name) {
  const matches = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith(`${name}=`));
  if (matches.length > 1) throw new Error(`环境变量 ${name} 重复`);
  if (matches.length === 0) return undefined;
  const raw = matches[0].slice(name.length + 1).trim();
  const unquoted = (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) ? raw.slice(1, -1) : raw;
  try {
    const value = JSON.parse(unquoted);
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new Error(`${name} 不是有效 JSON object`);
  }
}

function mergeSecret(base, overlay) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) {
      delete result[key];
    } else if (isRecord(value)) {
      result[key] = mergeSecret(isRecord(result[key]) ? result[key] : {}, value);
      if (Object.keys(result[key]).length === 0) delete result[key];
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

export function updateSecretText(text, instanceId, update) {
  const name = secretName(instanceId);
  const lines = text ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const indexes = lines
    .map((line, index) => line.trim().startsWith(`${name}=`) ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length > 1) throw new Error(`环境变量 ${name} 重复`);
  const current = indexes.length ? envValue(text, name) : {};
  const next = mergeSecret(current || {}, update);
  const nextLine = `${name}='${JSON.stringify(next)}'`;
  if (indexes.length) lines[indexes[0]] = nextLine;
  else lines.push(nextLine);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function renameSecretText(text, fromInstanceId, toInstanceId) {
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

function mergeObjects(base, overlay) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = isRecord(value) && isRecord(result[key]) ? mergeObjects(result[key], value) : structuredClone(value);
  }
  return result;
}

function effectiveA2a(settings, workspace) {
  const root = isRecord(settings.a2a) ? structuredClone(settings.a2a) : {};
  const profiles = isRecord(root.profiles) ? root.profiles : {};
  delete root.profiles;
  return isRecord(profiles[workspace]) ? mergeObjects(root, profiles[workspace]) : root;
}

function sanitizeProjectA2a(value) {
  if (!isRecord(value)) return {};
  const result = structuredClone(value);
  for (const key of ["profiles", "instanceId", "inboundPeers", "workspaces", "session", "trace", "verifySsl"]) delete result[key];
  if (isRecord(result.server)) {
    const server = { ...result.server };
    for (const key of ["enabled", "host", "sharedToken", "peerTokens", "trustedPeers", "allowAllUsers", "publicUrl", "rateLimitPerMinute", "rateLimitPerMin", "maxPingpongTurns", "maxConcurrent", "replyTimeoutMs", "executionTimeoutMs", "defaultWorkspaceId"]) delete server[key];
    result.server = server;
  }
  if (isRecord(result.discovery)) {
    const discovery = { ...result.discovery };
    delete discovery.gateway;
    delete discovery.gateways;
    delete discovery.enrichCard;
    if (isRecord(discovery.mdns)) discovery.mdns = { ...discovery.mdns, enabled: undefined };
    result.discovery = discovery;
  }
  return result;
}

function configurationTarget(settings, workspace) {
  if (!isRecord(settings.a2a)) settings.a2a = {};
  if (!isRecord(settings.a2a.profiles)) settings.a2a.profiles = {};
  if (!isRecord(settings.a2a.profiles[workspace])) settings.a2a.profiles[workspace] = {};
  return settings.a2a.profiles[workspace];
}

export function hasA2aPlugin(settings, agentDir = DEFAULT_AGENT_DIR, loaded = false) {
  const sources = [
    ...(Array.isArray(settings.packages) ? settings.packages : []),
    ...(Array.isArray(settings.extensions) ? settings.extensions : []),
  ];
  const entry = sources.find((item) => /zhangst_a2a-pi|@zhangst\/pi-a2a|(?:^|[/_-])pi-a2a/i.test(JSON.stringify(item)));
  const source = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.source === "string" ? entry.source : undefined;
  let available = false;
  if (source) {
    if (/^(?:\.|\/|[A-Za-z]:[\\/])/.test(source)) available = existsSync(resolve(agentDir, source));
    else if (source.startsWith("npm:")) {
      const spec = source.slice(4);
      const name = spec.startsWith("@") ? spec.split("@").slice(0, 2).join("@").replace(/@$/, "") : spec.split("@")[0];
      available = existsSync(join(agentDir, "npm", "node_modules", name));
    } else available = true;
  }
  return { configured: source !== undefined, available, loaded, source, installed: source !== undefined };
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readRegistry(agentDir, { now = Date.now(), ttlMs = 60_000, alive = isPidAlive } = {}) {
  const directory = join(agentDir, "a2a_registry");
  if (!existsSync(directory)) return [];
  const result = [];
  for (const name of readdirSync(directory)) {
    if (!/^\d+\.json$/.test(name)) continue;
    const path = join(directory, name);
    try {
      const descriptor = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(descriptor) || Number(descriptor.pid) !== Number(name.replace(".json", ""))) continue;
      if (now - statSync(path).mtimeMs > ttlMs || !alive(Number(descriptor.pid))) continue;
      result.push({ ...descriptor, pid: Number(descriptor.pid) });
    } catch {}
  }
  return result;
}

export function readRuntimeRegistry(agentDir, { now = Date.now(), ttlMs = 60_000, alive = isPidAlive } = {}) {
  const directory = join(agentDir, "a2a_runtime");
  if (!existsSync(directory)) return [];
  const result = [];
  for (const name of readdirSync(directory)) {
    if (!/^\d+\.json$/.test(name)) continue;
    const path = join(directory, name);
    try {
      const descriptor = JSON.parse(readFileSync(path, "utf8"));
      const pid = Number(name.replace(".json", ""));
      if (
        !isRecord(descriptor) ||
        Number(descriptor.pid) !== pid ||
        typeof descriptor.cwd !== "string" ||
        typeof descriptor.instanceId !== "string"
      ) continue;
      if (now - statSync(path).mtimeMs > ttlMs || !alive(pid)) continue;
      result.push({ ...descriptor, pid });
    } catch {}
  }
  return result;
}

export function parsePiProcessList(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(.+?)\s*$/.exec(line))
    .filter((match) => match && basename(match[2]) === "pi")
    .map((match) => ({ pid: Number(match[1]) }));
}

export function findRunningPiProcesses(workspaces, {
  platform = process.platform,
  processList = () => execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 2000 }),
  processCwd = (pid) => {
    const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 2000 });
    return output.split(/\r?\n/).find((line) => line.startsWith("n"))?.slice(1);
  },
} = {}) {
  if (platform !== "darwin") return [];
  const managed = new Set(workspaces.map((workspace) => {
    try { return realpathSync(workspace); } catch { return resolve(workspace); }
  }));
  let candidates;
  try { candidates = parsePiProcessList(processList()); } catch { return []; }
  const result = [];
  for (const candidate of candidates) {
    try {
      const cwd = realpathSync(processCwd(candidate.pid));
      if (managed.has(cwd)) result.push({ pid: candidate.pid, cwd });
    } catch {}
  }
  return result;
}

export function buildRuntimeStatuses(instances, runningProcesses) {
  return instances.map((instance) => {
    const loaded = [...(instance.runtime || []), ...(instance.registry || [])];
    const loadedPids = [...new Set(loaded.map((entry) => Number(entry.pid)).filter(Number.isInteger))];
    const cwdPids = runningProcesses.filter((entry) => entry.cwd === instance.workspace).map((entry) => entry.pid);
    const unconfirmedPids = cwdPids.filter((pid) => !loadedPids.includes(pid));
    return {
      key: instance.key,
      status: unconfirmedPids.length ? "unconfirmed" : loadedPids.length ? "loaded" : "stopped",
      pids: [...new Set([...loadedPids, ...cwdPids])],
      loadedPids,
      unconfirmedPids,
    };
  });
}

export function readWorkspace(workspacePath, agentDir = DEFAULT_AGENT_DIR) {
  const paths = pathsForWorkspace(workspacePath, agentDir);
  const projectSettings = readJsonFile(paths.projectSettingsPath);
  const agentSettings = readJsonFile(paths.settingsPath);
  const settings = agentSettings.value;
  const a2a = mergeObjects(effectiveA2a(settings, paths.workspace), sanitizeProjectA2a(projectSettings.value.a2a));
  const instanceId = typeof a2a.instanceId === "string" ? a2a.instanceId : normalizeInstanceId(basename(paths.workspace), paths.workspace);
  const server = isRecord(a2a.server) ? a2a.server : {};
  const workspaceId = typeof server.defaultWorkspaceId === "string" && server.defaultWorkspaceId
    ? server.defaultWorkspaceId
    : normalizeInstanceId(basename(paths.workspace), paths.workspace);
  const workspaces = isRecord(a2a.workspaces) ? a2a.workspaces : {};
  const configuredWorkspace = isRecord(workspaces[workspaceId]) ? workspaces[workspaceId] : {};
  const envText = existsSync(paths.envPath) ? readFileSync(paths.envPath, "utf8") : "";
  const secret = envValue(envText, secretName(instanceId)) || {};
  const outboundSecrets = isRecord(secret.outbound) && isRecord(secret.outbound.peers) ? secret.outbound.peers : {};
  const inboundSecrets = isRecord(secret.server) && isRecord(secret.server.peerTokens) ? secret.server.peerTokens : {};
  const peers = isRecord(a2a.peers) ? a2a.peers : {};
  const inboundPeers = isRecord(a2a.inboundPeers) ? a2a.inboundPeers : {};
  const registry = readRegistry(paths.agentDir).filter((entry) => entry.cwd === paths.workspace);
  const runtime = readRuntimeRegistry(paths.agentDir).filter((entry) => entry.cwd === paths.workspace);
  const legacySettingsPath = join(paths.workspace, ".pi", "agent", "settings.json");
  const legacySettings = readJsonFile(legacySettingsPath);
  return {
    key: instanceKey(paths.agentDir, paths.workspace),
    workspace: paths.workspace,
    agentDir: paths.agentDir,
    settingsPath: paths.settingsPath,
    envPath: paths.envPath,
    projectSettings: {
      exists: projectSettings.exists,
      hasA2a: isRecord(projectSettings.value.a2a),
    },
    legacyA2aExists: isRecord(legacySettings.value.a2a),
    legacySettingsPath,
    configured: isRecord(settings.a2a) && isRecord(settings.a2a.profiles) && isRecord(settings.a2a.profiles[paths.workspace]),
    instanceId,
    agentName: typeof server.agentName === "string" && server.agentName ? server.agentName : basename(paths.workspace),
    server: {
      enabled: server.enabled === true,
      host: typeof server.host === "string" ? server.host : DEFAULT_HOST,
      port: Number.isInteger(server.port) ? server.port : BASE_PORT,
      portFallback: Number.isInteger(server.portFallback) ? server.portFallback : PORT_FALLBACK,
      publicUrl: typeof server.publicUrl === "string" ? server.publicUrl : "",
    },
    workspaceConfig: {
      id: workspaceId,
      root: typeof configuredWorkspace.root === "string" ? configuredWorkspace.root : paths.workspace,
    },
    peers: Object.entries(peers).map(([name, value]) => ({
      name,
      url: isRecord(value) && typeof value.url === "string" ? value.url : "",
      timeoutMs: isRecord(value) && typeof value.timeoutMs === "number" ? value.timeoutMs : undefined,
      token: isRecord(outboundSecrets[name]) && typeof outboundSecrets[name].token === "string" ? outboundSecrets[name].token : "",
    })),
    inbound: Object.keys(inboundPeers).map((name) => ({
      name,
      token: typeof inboundSecrets[name] === "string" ? inboundSecrets[name] : "",
    })),
    plugin: hasA2aPlugin(settings, paths.agentDir, runtime.length > 0 || registry.length > 0),
    registry,
    runtime,
    actualPort: registry[0]?.port,
    settingsHash: agentSettings.hash,
    envHash: existsSync(paths.envPath) ? hashText(envText) : null,
    startCommand: `cd ${shellQuote(paths.workspace)} && pi`,
  };
}

export function inspectWorkspace(workspacePath, managedInstances = [], agentDir = DEFAULT_AGENT_DIR) {
  const paths = pathsForWorkspace(workspacePath, agentDir);
  const projectSettings = readJsonFile(paths.projectSettingsPath);
  const agentSettings = readJsonFile(paths.settingsPath);
  if (agentSettings.exists && Object.hasOwn(agentSettings.value, "a2a") && !isRecord(agentSettings.value.a2a)) {
    throw new Error(`${paths.settingsPath} 的 a2a 必须是 object`);
  }
  const usedIds = new Set();
  for (const managed of managedInstances) if (managed?.instanceId) usedIds.add(managed.instanceId);
  const profile = isRecord(agentSettings.value.a2a) && isRecord(agentSettings.value.a2a.profiles)
    ? agentSettings.value.a2a.profiles[paths.workspace]
    : undefined;
  const legacySettingsPath = join(paths.workspace, ".pi", "agent", "settings.json");
  return {
    ...paths,
    key: instanceKey(paths.agentDir, paths.workspace),
    folderName: basename(paths.workspace),
    piExists: existsSync(paths.projectDir),
    projectSettingsExists: projectSettings.exists,
    agentSettingsExists: agentSettings.exists,
    existingA2a: isRecord(profile),
    legacyA2aExists: (() => { try { return isRecord(readJsonFile(legacySettingsPath).value.a2a); } catch { return false; } })(),
    legacySettingsPath,
    projectA2aExists: isRecord(projectSettings.value.a2a),
    instanceId: normalizeInstanceId(basename(paths.workspace), paths.workspace, usedIds),
    agentName: basename(paths.workspace),
    plugin: hasA2aPlugin(agentSettings.value, paths.agentDir),
  };
}

export function readAgentDirectories(agentDirs = [DEFAULT_AGENT_DIR]) {
  const instances = [];
  for (const agentDirInput of agentDirs) {
    const agentDir = resolve(agentDirInput);
    const settings = readJsonFile(join(agentDir, "settings.json"));
    const profiles = isRecord(settings.value.a2a) && isRecord(settings.value.a2a.profiles) ? settings.value.a2a.profiles : {};
    for (const workspace of Object.keys(profiles)) {
      try { instances.push(readWorkspace(workspace, agentDir)); }
      catch (error) { instances.push({ key: instanceKey(agentDir, workspace), workspace, agentDir, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  return instances;
}

export function buildInitialA2a({ workspace, instanceId, agentName, port }) {
  return {
    instanceId,
    server: {
      enabled: false,
      host: DEFAULT_HOST,
      port,
      portFallback: PORT_FALLBACK,
      agentName,
      defaultWorkspaceId: instanceId,
    },
    workspaces: {
      [instanceId]: {
        root: workspace,
        allowedPeers: [],
        allowedAgents: ["coding"],
      },
    },
    discovery: {
      local: { enabled: true, heartbeatSec: 15, ttlSec: 60 },
    },
  };
}

export async function probePort(host, port) {
  return new Promise((resolveProbe) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => resolveProbe(false));
    probe.listen(port, host, () => probe.close(() => resolveProbe(true)));
  });
}

export async function choosePort(instances, start = BASE_PORT, probe = probePort) {
  const used = new Set(instances.flatMap((instance) => [instance.server?.port, instance.actualPort]).filter(Number.isInteger));
  for (let port = start; port <= 65535; port += 1) {
    if (used.has(port)) continue;
    if (await probe(DEFAULT_HOST, port)) return port;
  }
  throw new Error("没有可用 A2A 端口");
}

export function hostsConflict(left, right) {
  if (left === right) return true;
  const wildcardV4 = new Set(["0.0.0.0", ""]);
  return wildcardV4.has(left) || wildcardV4.has(right);
}

function publicUrlPort(publicUrl) {
  if (!publicUrl) return undefined;
  try {
    const parsed = new URL(publicUrl);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
}

export async function buildPortStatus(instances, probe = probePort) {
  const result = instances.map((instance) => ({
    key: instance.key,
    workspace: instance.workspace,
    instanceId: instance.instanceId,
    agentName: instance.agentName,
    enabled: instance.server.enabled,
    host: instance.server.host,
    configuredPort: instance.server.port,
    actualPort: instance.actualPort,
    conflicts: [],
    severity: "none",
    status: instance.configured ? (instance.server.enabled ? (instance.actualPort ? "running" : "waiting") : "disabled") : "unconfigured",
  }));

  for (let leftIndex = 0; leftIndex < result.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < result.length; rightIndex += 1) {
      const left = result[leftIndex];
      const right = result[rightIndex];
      if (left.configuredPort === right.configuredPort && hostsConflict(left.host, right.host)) {
        left.conflicts.push({ type: "configured-port-duplicate", otherKey: right.key, otherName: right.agentName, port: left.configuredPort });
        right.conflicts.push({ type: "configured-port-duplicate", otherKey: left.key, otherName: left.agentName, port: right.configuredPort });
      }
      if (left.actualPort && left.actualPort === right.actualPort && hostsConflict(left.host, right.host)) {
        left.conflicts.push({ type: "actual-port-duplicate", otherKey: right.key, otherName: right.agentName, port: left.actualPort });
        right.conflicts.push({ type: "actual-port-duplicate", otherKey: left.key, otherName: left.agentName, port: right.actualPort });
      }
    }
  }

  for (const item of result) {
    const source = instances.find((instance) => instance.key === item.key);
    if (item.actualPort && item.actualPort !== item.configuredPort) {
      item.conflicts.push({ type: "fallback-port", configuredPort: item.configuredPort, actualPort: item.actualPort });
      item.status = "fallback";
    }
    const advertisedPort = publicUrlPort(source.server.publicUrl);
    if (item.enabled && item.host === "0.0.0.0" && !source.server.publicUrl) {
      item.conflicts.push({ type: "missing-public-url" });
    }
    if (item.actualPort && advertisedPort && advertisedPort !== item.actualPort) {
      item.conflicts.push({ type: "public-url-port-mismatch", publicPort: advertisedPort, actualPort: item.actualPort });
    }
    const occupied = !(await probe(item.host, item.configuredPort));
    const ownedByThisInstance = item.actualPort === item.configuredPort;
    const ownedByManagedPi = result.some((candidate) => candidate.key !== item.key && candidate.actualPort === item.configuredPort && hostsConflict(candidate.host, item.host));
    if (occupied && !ownedByThisInstance && !ownedByManagedPi) {
      item.conflicts.push({ type: "occupied-by-other-process", port: item.configuredPort });
    }
    if (item.conflicts.some((entry) => entry.type === "actual-port-duplicate")) {
      item.severity = "error";
      item.status = "error";
    } else if (item.conflicts.length) {
      item.severity = "warning";
      if (item.status !== "fallback") item.status = "port-conflict";
    }
  }
  return result;
}

export async function initializeWorkspace({
  workspacePath,
  instances,
  agentDir = DEFAULT_AGENT_DIR,
  onStage = () => {},
  probe = probePort,
}) {
  onStage("inspect");
  const inspection = inspectWorkspace(workspacePath, instances, agentDir);
  onStage("configure");
  mkdirSync(inspection.agentDir, { recursive: true, mode: 0o700 });
  let settings = readJsonFile(inspection.settingsPath);
  if (!settings.exists) {
    writeAtomically(inspection.settingsPath, "{}\n", 0o600);
    settings = readJsonFile(inspection.settingsPath, { required: true });
  }
  let a2aCreated = false;
  if (!inspection.existingA2a) {
    const port = await choosePort(instances, BASE_PORT, probe);
    if (!isRecord(settings.value.a2a)) settings.value.a2a = {};
    if (!isRecord(settings.value.a2a.profiles)) settings.value.a2a.profiles = {};
    settings.value.a2a.profiles[inspection.workspace] = buildInitialA2a({
      workspace: inspection.workspace,
      instanceId: inspection.instanceId,
      agentName: inspection.agentName,
      port,
    });
    writeAtomically(inspection.settingsPath, `${JSON.stringify(settings.value, null, 2)}\n`, fileMode(inspection.settingsPath, 0o600));
    a2aCreated = true;
  }

  onStage("complete");
  return {
    inspection,
    instance: readWorkspace(inspection.workspace, inspection.agentDir),
    a2aCreated,
    a2aPreserved: inspection.existingA2a,
    projectSettingsPreserved: inspection.projectSettingsPath,
    plugin: hasA2aPlugin(readJsonFile(inspection.settingsPath, { required: true }).value, inspection.agentDir),
  };
}

export function findPiInstallations() {
  const found = [];
  const seen = new Set();
  const add = (path, source) => {
    if (!path || !existsSync(path)) return;
    try {
      const realPath = realpathSync(path);
      if (seen.has(realPath)) return;
      seen.add(realPath);
      let version;
      try {
        const javascriptCli = isJavaScriptCli(path);
        const nodePath = process.env.A2A_CONFIG_NODE || process.execPath;
        const command = javascriptCli ? nodePath : path;
        const args = javascriptCli ? [realPath, "--version"] : ["--version"];
        version = execFileSync(command, args, { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.A2A_CONFIG_NODE ? undefined : process.versions.electron ? "1" : process.env.ELECTRON_RUN_AS_NODE } }).trim();
      } catch {}
      found.push({ executablePath: path, realPath, source, version });
    } catch {}
  };
  if (process.env.A2A_CONFIG_PI) add(process.env.A2A_CONFIG_PI, "environment");
  for (const directory of String(process.env.PATH || "").split(delimiter)) {
    add(join(directory, process.platform === "win32" ? "pi.cmd" : "pi"), "path");
  }
  add(join(homedir(), ".npm-global", "bin", "pi"), "npm");
  add(join(homedir(), ".bun", "bin", "pi"), "bun");
  for (const [command, args, source] of [
    ["npm", ["root", "-g"], "npm"],
    ["pnpm", ["root", "-g"], "pnpm"],
    ["bun", ["pm", "bin", "-g"], "bun"],
  ]) {
    try {
      const root = execFileSync(command, args, { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim();
      add(join(root, "pi"), source);
      add(join(root, "@earendil-works", "pi-coding-agent", "dist", "cli.js"), source);
      add(join(root, "pi-coding-agent", "dist", "cli.js"), source);
    } catch {}
  }
  return found;
}

function isJavaScriptCli(candidate) {
  try { return realpathSync(candidate).endsWith(".js"); }
  catch { return candidate.endsWith(".js"); }
}


export function applyWorkspaceDraft(settings, workspace, draft) {
  const next = structuredClone(settings);
  if (!isRecord(next.a2a)) next.a2a = {};
  const target = configurationTarget(next, workspace);
  if (draft.instanceId !== undefined) target.instanceId = draft.instanceId;
  if (!isRecord(target.server)) target.server = {};
  for (const key of ["enabled", "host", "port", "portFallback", "agentName", "publicUrl", "defaultWorkspaceId"]) {
    if (draft.server?.[key] === undefined) continue;
    if (key === "publicUrl" && draft.server[key] === "") delete target.server[key];
    else target.server[key] = draft.server[key];
  }
  const workspaceId = draft.workspaceConfig?.id || target.server.defaultWorkspaceId;
  if (workspaceId) {
    const previousWorkspaceId = target.server.defaultWorkspaceId;
    target.server.defaultWorkspaceId = workspaceId;
    if (!isRecord(target.workspaces)) target.workspaces = {};
    const existing = isRecord(target.workspaces[workspaceId])
      ? target.workspaces[workspaceId]
      : isRecord(target.workspaces[previousWorkspaceId]) ? target.workspaces[previousWorkspaceId] : {};
    if (previousWorkspaceId && previousWorkspaceId !== workspaceId) delete target.workspaces[previousWorkspaceId];
    target.workspaces[workspaceId] = {
      ...existing,
      root: draft.workspaceConfig?.root || workspace,
      allowedPeers: Array.isArray(existing.allowedPeers) ? existing.allowedPeers : [],
      allowedAgents: Array.isArray(existing.allowedAgents) ? existing.allowedAgents : ["coding"],
    };
  }
  if (draft.outgoing?.length) {
    if (!isRecord(target.peers)) target.peers = {};
    for (const connection of draft.outgoing) {
      if (connection.originalName && connection.originalName !== connection.name) delete target.peers[connection.originalName];
      const existing = isRecord(target.peers[connection.name]) ? target.peers[connection.name] : {};
      target.peers[connection.name] = {
        ...existing,
        url: connection.url,
      };
      if (connection.timeoutMs === null) delete target.peers[connection.name].timeoutMs;
      else if (connection.timeoutMs !== undefined) target.peers[connection.name].timeoutMs = connection.timeoutMs;
    }
  }
  if (draft.incoming?.length) {
    if (!isRecord(target.inboundPeers)) target.inboundPeers = {};
    if (!isRecord(target.workspaces)) target.workspaces = {};
    const workspaceEntry = isRecord(target.workspaces[workspaceId]) ? target.workspaces[workspaceId] : { root: workspace, allowedAgents: ["coding"] };
    for (const connection of draft.incoming) {
      target.inboundPeers[connection.name] = {
        scopes: ["message:send", "task:read"],
        allowedWorkspaces: [],
        allowedAgents: ["coding"],
        allowedTools: ["read", "grep", "find", "ls", "write", "edit", "bash"],
      };
    }
    workspaceEntry.allowedPeers = [...new Set([
      ...(Array.isArray(workspaceEntry.allowedPeers) ? workspaceEntry.allowedPeers : []),
      ...draft.incoming.map((entry) => entry.name),
    ])];
    target.workspaces[workspaceId] = workspaceEntry;
  }
  for (const name of draft.removeIncoming || []) {
    if (isRecord(target.inboundPeers)) delete target.inboundPeers[name];
    for (const entry of Object.values(isRecord(target.workspaces) ? target.workspaces : {})) {
      if (isRecord(entry) && Array.isArray(entry.allowedPeers)) entry.allowedPeers = entry.allowedPeers.filter((peer) => peer !== name);
    }
  }
  for (const name of draft.removeOutgoing || []) {
    if (isRecord(target.peers)) delete target.peers[name];
  }
  return next;
}

export function secretUpdateFromDraft(draft) {
  const update = {};
  if (draft.outgoing?.length) {
    const peers = {};
    for (const entry of draft.outgoing) {
      if (entry.originalName && entry.originalName !== entry.name) peers[entry.originalName] = null;
      peers[entry.name] = { token: entry.token };
    }
    update.outbound = { peers };
  }
  if (draft.incoming?.length) {
    update.server = { peerTokens: Object.fromEntries(draft.incoming.map((entry) => [entry.name, entry.token])) };
  }
  if (draft.removeIncoming?.length) {
    update.server = {
      ...(update.server || {}),
      peerTokens: {
        ...(update.server?.peerTokens || {}),
        ...Object.fromEntries(draft.removeIncoming.map((name) => [name, null])),
      },
    };
  }
  if (draft.removeOutgoing?.length) {
    update.outbound = {
      ...(update.outbound || {}),
      peers: {
        ...(update.outbound?.peers || {}),
        ...Object.fromEntries(draft.removeOutgoing.map((name) => [name, null])),
      },
    };
  }
  return Object.keys(update).length ? update : null;
}

export function createToken() {
  return `a2a_${randomBytes(32).toString("base64url")}`;
}

export function acquireLocks(paths) {
  const locks = [];
  try {
    for (const path of [...paths].sort()) {
      const lockPath = `${path}.a2a-config.lock`;
      locks.push({ fd: openSync(lockPath, "wx", 0o600), lockPath });
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

export function writeAtomically(path, content, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { mode });
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

export function fileMode(path, fallback = 0o600) {
  try { return statSync(path).mode & 0o777; } catch { return fallback; }
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
