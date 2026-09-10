import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hashText, hostsConflict, probePort, readAppState, updateAppState } from "./core.mjs";

const WORKER_PATH = fileURLToPath(new URL("./rclone-worker.mjs", import.meta.url));
const FILE_PORT = 2022;

function executableCandidates(name, envPath = process.env.PATH || "") {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return envPath.split(delimiter).flatMap((directory) => suffixes.map((suffix) => join(directory, `${name}${suffix}`)));
}

export function findExecutable(name, override) {
  for (const candidate of [override, ...executableCandidates(name)]) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {}
  }
  return null;
}

export function dependencyStatus() {
  const rclonePath = findExecutable("rclone", process.env.A2A_CONFIG_RCLONE);
  const sshKeygenPath = findExecutable("ssh-keygen", process.env.A2A_CONFIG_SSH_KEYGEN);
  const install = process.platform === "darwin"
    ? "brew install rclone\n# ssh-keygen 由 macOS OpenSSH 提供"
    : process.platform === "win32"
      ? "winget install Rclone.Rclone\nAdd-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0"
      : "sudo apt install rclone openssh-client";
  return { rclonePath, sshKeygenPath, ready: Boolean(rclonePath && sshKeygenPath), install };
}

export function normalizeFileRoot(input) {
  const candidate = resolve(String(input || ""));
  if (!existsSync(candidate)) throw new Error("文件空间目录不存在");
  const root = realpathSync(candidate);
  if (!statSync(root).isDirectory()) throw new Error("文件空间根路径必须是目录");
  accessSync(root, constants.R_OK | constants.W_OK);
  return root;
}

export function defaultPublicHosts(instances = [], { interfaces = networkInterfaces(), run = execFileSync } = {}) {
  const result = [];
  for (const instance of instances) {
    if (!instance.server?.publicUrl) continue;
    try {
      const hostname = new URL(instance.server.publicUrl).hostname;
      if (hostname && hostname !== "0.0.0.0" && hostname !== "127.0.0.1") result.push({ host: hostname, source: "a2a-public-url" });
    } catch {}
  }
  try {
    const host = run("tailscale", ["ip", "-4"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\s+/)[0];
    if (host) result.push({ host, source: "tailscale" });
  } catch {}
  const lan = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) lan.push(entry.address);
    }
  }
  if (new Set(lan).size === 1) result.push({ host: lan[0], source: "lan" });
  return [...new Map(result.map((entry) => [entry.host, entry])).values()];
}

export async function chooseFilePort(fileWorkspaces, start = FILE_PORT, probe = probePort) {
  const used = new Set(fileWorkspaces.map((entry) => entry.port));
  for (let port = start; port <= 65535; port += 1) {
    if (!used.has(port) && await probe("0.0.0.0", port)) return port;
  }
  throw new Error("没有可用的 SFTP 端口");
}

export function validateFileWorkspace(input, agents) {
  const root = normalizeFileRoot(input.root);
  const name = String(input.name || basename(root)).trim();
  const username = String(input.username || basename(root)).trim();
  const password = String(input.password || "");
  const port = Number(input.port);
  const boundAgentKeys = [...new Set(Array.isArray(input.boundAgentKeys) ? input.boundAgentKeys.filter((key) => agents.some((agent) => agent.key === key)) : [])];
  if (!name || name.length > 80) throw new Error("文件空间名称不能为空且不能超过 80 个字符");
  if (!username || username.length > 64 || /[\x00-\x20/:]/.test(username)) throw new Error("SFTP 用户名不能包含空格、控制字符、斜杠或冒号");
  if (!password || password.length > 1024) throw new Error("SFTP 密码不能为空且不能超过 1024 个字符");
  if (/[\r\n\0]/.test(password)) throw new Error("SFTP 密码不能包含换行或 NUL 字符");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SFTP 端口必须是 1 到 65535 的整数");
  if (boundAgentKeys.length === 0) throw new Error("至少关联一个 Agent");
  let parsed;
  try { parsed = new URL(input.publicUrl); } catch { throw new Error("对外地址必须是有效的 sftp:// URL"); }
  if (parsed.protocol !== "sftp:") throw new Error("对外地址必须使用 sftp://");
  if (!parsed.hostname || parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) throw new Error("对外地址只能包含主机和端口");
  const listenHost = String(input.listenHost || "0.0.0.0");
  if (/[\s\0]/.test(listenHost)) throw new Error("监听地址格式无效");
  return { root, name, username, password, port, boundAgentKeys, publicUrl: parsed.toString().replace(/\/$/, ""), listenHost };
}

function hostKeyDirectory(stateFile, id) {
  return join(dirname(stateFile), "file-transfer", id);
}

export function fileWorkspaceId(root) {
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return `files-${slug ? `${slug}-` : ""}${hashText(root).slice(0, 10)}`;
}

export function ensureHostKey(stateFile, id, sshKeygenPath, run = execFileSync) {
  const directory = hostKeyDirectory(stateFile, id);
  const privatePath = join(directory, "host_ed25519");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(privatePath) || !existsSync(`${privatePath}.pub`)) {
    run(sshKeygenPath, ["-q", "-t", "ed25519", "-N", "", "-f", privatePath], { timeout: 10_000, stdio: "ignore" });
  }
  const publicLine = readFileSync(`${privatePath}.pub`, "utf8").trim();
  const hostPublicKey = publicLine.split(/\s+/).slice(0, 2).join(" ");
  const fingerprint = run(sshKeygenPath, ["-lf", `${privatePath}.pub`, "-E", "sha256"], { encoding: "utf8", timeout: 5000 }).trim().split(/\s+/)[1] || "";
  return { hostKeyPath: privatePath, hostPublicKey, fingerprint };
}

export class FileTransferManager {
  constructor({ stateFile, workerPath = WORKER_PATH, spawnImpl = spawn, probe = probePort } = {}) {
    this.stateFile = stateFile;
    this.workerPath = workerPath;
    this.spawnImpl = spawnImpl;
    this.probe = probe;
    this.processes = new Map();
    this.statuses = new Map();
    this.queue = Promise.resolve();
  }

  state() {
    return readAppState(this.stateFile);
  }

  list() {
    return this.state().fileWorkspaces.map((config) => ({ ...config, password: config.password, status: this.status(config.id) }));
  }

  status(id) {
    return this.statuses.get(id) || { state: "stopped", pid: null, attempts: 0, error: "" };
  }

  async inspect(root, agents = [], instances = []) {
    const normalized = normalizeFileRoot(root);
    const state = this.state();
    const duplicate = state.fileWorkspaces.find((entry) => entry.root === normalized);
    const dependencies = dependencyStatus();
    const hosts = defaultPublicHosts(instances);
    const suggestedPort = duplicate?.port || await chooseFilePort(state.fileWorkspaces);
    return { root: normalized, name: basename(normalized), username: basename(normalized), duplicateId: duplicate?.id || null, dependencies, hosts, suggestedPort, agents };
  }

  async create(input, agents = [], instances = []) {
    return this.enqueue(async () => {
      const dependencies = dependencyStatus();
      if (!dependencies.ready) throw new Error("请先安装 rclone 和 OpenSSH ssh-keygen");
      const state = this.state();
      const root = normalizeFileRoot(input.root);
      if (state.fileWorkspaces.some((entry) => entry.root === root)) throw new Error("该目录已经创建为文件空间");
      const port = input.port || await chooseFilePort(state.fileWorkspaces);
      if (state.fileWorkspaces.some((entry) => entry.port === port && hostsConflict(entry.listenHost, input.listenHost || "0.0.0.0"))) {
        throw new Error(`SFTP 端口 ${port} 已被其他文件空间配置`);
      }
      const hosts = defaultPublicHosts(instances);
      const publicUrl = input.publicUrl || (hosts[0] ? `sftp://${hosts[0].host}:${port}` : "");
      const validated = validateFileWorkspace({ ...input, root, port, publicUrl }, agents);
      if (!(await this.probe(validated.listenHost, validated.port))) throw new Error(`SFTP 端口 ${validated.port} 已被占用`);
      const id = fileWorkspaceId(root);
      const hostKey = ensureHostKey(this.stateFile, id, dependencies.sshKeygenPath);
      const config = { id, enabled: true, ...validated, ...hostKey };
      updateAppState((latest) => ({ ...latest, fileWorkspaces: [...latest.fileWorkspaces, config] }), this.stateFile);
      await this.start(config, dependencies.rclonePath);
      return { ...config, status: this.status(id) };
    });
  }

  async update(id, patch, agents) {
    return this.enqueue(async () => {
      const state = this.state();
      const current = state.fileWorkspaces.find((entry) => entry.id === id);
      if (!current) throw new Error("文件空间不存在");
      const validated = validateFileWorkspace({ ...current, ...patch, root: current.root }, agents);
      const next = { ...current, ...validated };
      if (state.fileWorkspaces.some((entry) => entry.id !== id && entry.port === next.port && hostsConflict(entry.listenHost, next.listenHost))) {
        throw new Error(`SFTP 端口 ${next.port} 已被其他文件空间配置`);
      }
      const restartRequired = ["listenHost", "port", "username", "password"].some((key) => current[key] !== next[key]);
      if (next.enabled && restartRequired && !dependencyStatus().rclonePath) throw new Error("rclone 未安装，无法应用需要重启的设置");
      if (restartRequired && (current.listenHost !== next.listenHost || current.port !== next.port) && !(await this.probe(next.listenHost, next.port))) {
        throw new Error(`SFTP 端口 ${next.port} 已被占用`);
      }
      updateAppState((latest) => ({ ...latest, fileWorkspaces: latest.fileWorkspaces.map((entry) => entry.id === id ? next : entry) }), this.stateFile);
      if (next.enabled && restartRequired) await this.start(next, dependencyStatus().rclonePath, true);
      return { ...next, status: this.status(id) };
    });
  }

  async setEnabled(id, enabled) {
    return this.enqueue(async () => {
      const state = this.state();
      const current = state.fileWorkspaces.find((entry) => entry.id === id);
      if (!current) throw new Error("文件空间不存在");
      const rclonePath = enabled ? dependencyStatus().rclonePath : null;
      if (enabled && !rclonePath) throw new Error("rclone 未安装");
      const next = { ...current, enabled };
      updateAppState((latest) => ({ ...latest, fileWorkspaces: latest.fileWorkspaces.map((entry) => entry.id === id ? next : entry) }), this.stateFile);
      if (enabled) {
        await this.start(next, rclonePath, true);
      } else await this.stop(id);
      return { ...next, status: this.status(id) };
    });
  }

  restart(id) {
    return this.enqueue(async () => {
      const config = this.state().fileWorkspaces.find((entry) => entry.id === id);
      if (!config) throw new Error("文件空间不存在");
      if (!config.enabled) throw new Error("文件空间已停用，请先启用");
      const rclonePath = dependencyStatus().rclonePath;
      if (!rclonePath) throw new Error("rclone 未安装");
      await this.start(config, rclonePath, true);
      return { ...config, status: this.status(id) };
    });
  }

  restore() {
    const rclonePath = dependencyStatus().rclonePath;
    for (const config of this.state().fileWorkspaces) {
      if (config.enabled && rclonePath) void this.start(config, rclonePath);
      else this.statuses.set(config.id, { state: config.enabled ? "dependency-missing" : "stopped", pid: null, attempts: 0, error: config.enabled ? "rclone 未安装" : "" });
    }
  }

  async start(config, rclonePath, replace = false) {
    if (replace) await this.stop(config.id);
    if (!this.processes.has(config.id)) this.spawnWorker(config, rclonePath);
    return this.status(config.id);
  }

  spawnWorker(config, rclonePath) {
    this.statuses.set(config.id, { state: "starting", pid: null, attempts: 0, error: "" });
    const worker = this.spawnImpl(process.execPath, [this.workerPath], {
      env: { ...process.env, A2A_SFTP_CONFIG: JSON.stringify({ ...config, rclonePath }) },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    this.processes.set(config.id, worker);
    worker.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      this.statuses.set(config.id, { state: message.type, pid: message.pid || null, attempts: message.attempts || 0, error: message.error || "", delayMs: message.delayMs || 0 });
    });
    worker.once("exit", (code) => {
      if (this.processes.get(config.id) !== worker) return;
      this.processes.delete(config.id);
      const current = this.status(config.id);
      if (current.state !== "stopped" && current.state !== "failed") this.statuses.set(config.id, { ...current, state: "failed", pid: null, error: current.error || `worker exited ${code}` });
    });
  }

  async stop(id) {
    const worker = this.processes.get(id);
    if (!worker) {
      this.statuses.set(id, { state: "stopped", pid: null, attempts: 0, error: "" });
      return;
    }
    this.processes.delete(id);
    worker.send?.({ type: "stop" });
    await new Promise((resolveStop) => {
      const timer = setTimeout(() => { worker.kill("SIGKILL"); resolveStop(); }, 5500);
      worker.once("exit", () => { clearTimeout(timer); resolveStop(); });
    });
    this.statuses.set(id, { state: "stopped", pid: null, attempts: 0, error: "" });
  }

  async stopAll() {
    await Promise.all([...this.processes.keys()].map((id) => this.stop(id)));
  }

  connectionInfo(agentId, agents) {
    const matches = agents.filter((agent) => agent.instanceId === agentId);
    if (matches.length !== 1) return [];
    return this.state().fileWorkspaces
      .filter((entry) => entry.enabled && entry.boundAgentKeys.includes(matches[0].key) && this.status(entry.id).state === "running")
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        url: entry.publicUrl,
        host: new URL(entry.publicUrl).hostname,
        port: Number(new URL(entry.publicUrl).port || 22),
        username: entry.username,
        password: entry.password,
        hostPublicKey: entry.hostPublicKey,
        fingerprint: entry.fingerprint,
      }));
  }

  async monitoredStatuses() {
    const configs = this.state().fileWorkspaces;
    const result = [];
    for (const config of configs) {
      const status = this.status(config.id);
      const duplicate = configs.find((entry) => entry.id !== config.id && entry.port === config.port && hostsConflict(entry.listenHost, config.listenHost));
      if (duplicate) {
        result.push({ id: config.id, state: "port-conflict", pid: status.pid || null, attempts: status.attempts || 0, error: `SFTP 端口 ${config.port} 与 ${duplicate.name} 重复` });
      } else if (!this.processes.has(config.id) && status.state !== "dependency-missing" && !(await this.probe(config.listenHost, config.port))) {
        result.push({ id: config.id, state: "port-conflict", pid: null, attempts: status.attempts || 0, error: `SFTP 端口 ${config.port} 已被占用` });
      } else result.push({ id: config.id, ...status });
    }
    return result;
  }

  enqueue(operation) {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export function writeRuntimeDescriptors(instances, url) {
  for (const instance of instances) {
    try {
      writeFileSync(join(instance.agentDir, "a2a_config_runtime.json"), `${JSON.stringify({ pid: process.pid, url, startedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    } catch {}
  }
}

export function removeRuntimeDescriptors(instances) {
  for (const instance of instances) {
    try { unlinkSync(join(instance.agentDir, "a2a_config_runtime.json")); } catch {}
  }
}
