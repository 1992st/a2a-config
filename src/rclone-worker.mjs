import { spawn } from "node:child_process";
import { connect } from "node:net";

const config = JSON.parse(process.env.A2A_SFTP_CONFIG || "{}");
const delays = [1000, 3000, 10_000];
let child;
let stopping = false;
let attempts = 0;
let lastError = "";

function notify(message) {
  if (process.send) process.send(message);
}

function start() {
  if (stopping) return;
  const env = Object.fromEntries([
    "PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec", "PATHEXT",
    "LANG", "LC_ALL", "TZ", "XDG_CACHE_HOME",
  ].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  env.RCLONE_USER = config.username;
  env.RCLONE_PASS = config.password;
  child = spawn(config.rclonePath, [
    "serve", "sftp", config.root,
    "--addr", `${config.listenHost}:${config.port}`,
    "--key", config.hostKeyPath,
    "--log-level", "INFO",
  ], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  child.once("spawn", async () => {
    const host = config.listenHost === "0.0.0.0" ? "127.0.0.1" : config.listenHost;
    for (let check = 0; check < 50 && child && !stopping; check += 1) {
      const ready = await new Promise((resolveReady) => {
        const socket = connect({ host, port: config.port });
        socket.once("connect", () => { socket.destroy(); resolveReady(true); });
        socket.once("error", () => resolveReady(false));
        socket.setTimeout(100, () => { socket.destroy(); resolveReady(false); });
      });
      if (ready) {
        notify({ type: "running", pid: child.pid, attempts });
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    lastError = String(chunk).trim().split(/\r?\n/).at(-1)?.slice(0, 500) || lastError;
  });
  child.once("error", (error) => {
    lastError = error.message;
  });
  child.once("exit", (code, signal) => {
    child = undefined;
    if (stopping) {
      notify({ type: "stopped" });
      process.exit(0);
    }
    if (attempts < delays.length) {
      const delayMs = delays[attempts];
      attempts += 1;
      notify({ type: "retrying", attempts, delayMs, error: lastError || `rclone exited ${code ?? signal}` });
      setTimeout(start, delayMs);
      return;
    }
    notify({ type: "failed", attempts, error: lastError || `rclone exited ${code ?? signal}` });
    process.exit(1);
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (!child) process.exit(0);
  child.kill("SIGTERM");
  setTimeout(() => child?.kill("SIGKILL"), 5000).unref();
}

process.on("message", (message) => {
  if (message?.type === "stop") stop();
});
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

start();
