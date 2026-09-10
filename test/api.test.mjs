import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function startTestServer(root) {
  const fakePi = join(root, "fake-pi.mjs");
  writeFileSync(fakePi, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const path = join(process.env.PI_CODING_AGENT_DIR, "settings.json");
const settings = JSON.parse(readFileSync(path, "utf8"));
settings.packages = [...(settings.packages || []), process.argv[3]];
writeFileSync(path, JSON.stringify(settings, null, 2) + "\\n");
`);
  chmodSync(fakePi, 0o755);
  const server = spawn(process.execPath, [resolve("src/server.mjs"), "--plugin-source", "/plugins/zhangst_a2a-pi"], {
    cwd: resolve("."),
    env: {
      ...process.env,
      A2A_CONFIG_PI: fakePi,
      A2A_CONFIG_STATE_FILE: join(root, "state.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  const baseUrl = await new Promise((resolveUrl, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`server timeout: ${stderr}`)), 5000);
    server.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /A2A Config: (http:\/\/[^\s]+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    });
    server.once("exit", (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
  });
  const rootResponse = await fetch(baseUrl);
  const cookie = rootResponse.headers.get("set-cookie")?.split(";")[0];
  return {
    baseUrl,
    cookie,
    server,
    async request(path, options = {}) {
      const response = await fetch(new URL(path, baseUrl), {
        ...options,
        headers: {
          cookie,
          origin: baseUrl.replace(/\/$/, ""),
          "content-type": "application/json",
          ...(options.headers || {}),
        },
      });
      return { response, body: await response.json() };
    },
    stop() {
      server.kill("SIGTERM");
    },
  };
}

async function waitForOperation(client, id) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { body } = await client.request(`/api/operations/${id}`);
    if (body.status !== "running") return body;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("operation did not complete");
}

test("workspace API completes initialization and the Server enable wizard", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-config-api-"));
  const workspace = join(root, "remote-project");
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  const projectSettingsPath = join(workspace, ".pi", "settings.json");
  const originalProjectSettings = '{"theme":"dark","a2a":{"existing":true}}\n';
  writeFileSync(projectSettingsPath, originalProjectSettings);
  const client = await startTestServer(root);
  try {
    const inspected = await client.request("/api/workspaces/inspect", {
      method: "POST",
      body: JSON.stringify({ path: workspace }),
    });
    assert.equal(inspected.response.status, 200);
    assert.equal(inspected.body.agentName, "remote-project");
    assert.equal(inspected.body.projectA2aExists, true);
    assert.equal(inspected.body.projectSettingsExists, true);
    assert.equal(inspected.body.agentSettingsExists, false);
    assert.equal(inspected.body.suggestedPort, 9910);

    const started = await client.request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ path: workspace }),
    });
    assert.equal(started.response.status, 202);
    const operation = await waitForOperation(client, started.body.id);
    assert.equal(operation.status, "complete");
    assert.equal(readFileSync(projectSettingsPath, "utf8"), originalProjectSettings);

    const state = await client.request("/api/state");
    assert.equal(state.body.workspaces.length, 1);
    const instance = state.body.workspaces[0];
    assert.equal(instance.agentName, "remote-project");
    assert.equal(instance.server.host, "0.0.0.0");
    assert.equal(instance.server.enabled, false);
    assert.equal(instance.plugin.installed, true);

    const enableCheck = await client.request(`/api/instances/${instance.key}/server/enable`, {
      method: "POST",
      body: JSON.stringify({ draft: { outgoing: [{ name: "remote", url: "http://remote:9910", token: "remote-token" }] } }),
    });
    assert.equal(enableCheck.body.connectionRequired, true);
    assert.match(enableCheck.body.suggestedToken, /^a2a_/);

    const enable = await client.request(`/api/instances/${instance.key}/server/enable`, {
      method: "POST",
      body: JSON.stringify({ connectionName: "local-pi", token: enableCheck.body.suggestedToken, draft: { outgoing: [{ name: "remote", url: "http://remote:9910", token: "remote-token" }] } }),
    });
    assert.equal(enable.body.connectionRequired, false);
    assert.ok(enable.body.previewId);

    const applied = await client.request("/api/config/apply", {
      method: "POST",
      body: JSON.stringify({ previewId: enable.body.previewId }),
    });
    assert.equal(applied.body.ok, true);
    const settings = JSON.parse(readFileSync(join(workspace, ".pi", "agent", "settings.json"), "utf8"));
    assert.equal(settings.a2a.server.enabled, true);
    assert.ok(settings.a2a.inboundPeers["local-pi"]);
    assert.equal(settings.a2a.peers.remote.url, "http://remote:9910");
    const env = readFileSync(join(workspace, ".pi", "agent", ".env.local"), "utf8");
    assert.match(env, /local-pi/);
    assert.match(env, /remote-token/);
  } finally {
    client.stop();
  }
});

test("outgoing connections can be edited, renamed, and deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-config-outgoing-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const client = await startTestServer(root);
  try {
    const started = await client.request("/api/workspaces", { method: "POST", body: JSON.stringify({ path: workspace }) });
    const operation = await waitForOperation(client, started.body.id);
    assert.equal(operation.status, "complete");

    const added = await client.request("/api/config/preview", {
      method: "POST",
      body: JSON.stringify({ workspace, draft: { outgoing: [{ name: "old", url: "http://old:9910/a2a/v1", token: "old-token", timeoutMs: 5000 }] } }),
    });
    await client.request("/api/config/apply", { method: "POST", body: JSON.stringify({ previewId: added.body.previewId }) });

    const edited = await client.request("/api/config/preview", {
      method: "POST",
      body: JSON.stringify({ workspace, draft: { outgoing: [{ name: "new", originalName: "old", url: "http://new:9920/a2a/v1", token: "new-token", timeoutMs: null }] } }),
    });
    const editApply = await client.request("/api/config/apply", { method: "POST", body: JSON.stringify({ previewId: edited.body.previewId }) });
    assert.equal(editApply.body.ok, true);
    const settingsPath = join(workspace, ".pi", "agent", "settings.json");
    const envPath = join(workspace, ".pi", "agent", ".env.local");
    const afterEdit = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(afterEdit.a2a.peers.old, undefined);
    assert.deepEqual(afterEdit.a2a.peers.new, { url: "http://new:9920/a2a/v1" });
    assert.doesNotMatch(readFileSync(envPath, "utf8"), /old-token|"old"/);
    assert.match(readFileSync(envPath, "utf8"), /new-token/);

    const removed = await client.request("/api/config/preview", {
      method: "POST",
      body: JSON.stringify({ workspace, draft: { removeOutgoing: ["new"] } }),
    });
    const removeApply = await client.request("/api/config/apply", { method: "POST", body: JSON.stringify({ previewId: removed.body.previewId }) });
    assert.equal(removeApply.body.ok, true);
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).a2a.peers.new, undefined);
    assert.doesNotMatch(readFileSync(envPath, "utf8"), /new-token|"new"/);
  } finally {
    client.stop();
  }
});

test("concurrent workspace initialization keeps both paths and allocates unique identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-config-concurrent-"));
  const first = join(root, "first", "project");
  const second = join(root, "second", "project");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  const client = await startTestServer(root);
  try {
    const [firstStart, secondStart] = await Promise.all([
      client.request("/api/workspaces", { method: "POST", body: JSON.stringify({ path: first }) }),
      client.request("/api/workspaces", { method: "POST", body: JSON.stringify({ path: second }) }),
    ]);
    const [firstOperation, secondOperation] = await Promise.all([
      waitForOperation(client, firstStart.body.id),
      waitForOperation(client, secondStart.body.id),
    ]);
    assert.equal(firstOperation.status, "complete");
    assert.equal(secondOperation.status, "complete");
    const state = await client.request("/api/state");
    assert.equal(state.body.workspaces.length, 2);
    assert.equal(new Set(state.body.workspaces.map((entry) => entry.instanceId)).size, 2);
    assert.equal(new Set(state.body.workspaces.map((entry) => entry.server.port)).size, 2);
  } finally {
    client.stop();
  }
});

test("apply rejects external changes made after preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-config-conflict-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const client = await startTestServer(root);
  try {
    const started = await client.request("/api/workspaces", { method: "POST", body: JSON.stringify({ path: workspace }) });
    const operation = await waitForOperation(client, started.body.id);
    assert.equal(operation.status, "complete");
    const settingsPath = join(workspace, ".pi", "agent", "settings.json");
    const preview = await client.request("/api/config/preview", {
      method: "POST",
      body: JSON.stringify({ workspace, draft: { server: { port: 12000 } } }),
    });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.externalChange = true;
    writeFileSync(settingsPath, JSON.stringify(settings));
    const apply = await client.request("/api/config/apply", {
      method: "POST",
      body: JSON.stringify({ previewId: preview.body.previewId }),
    });
    assert.equal(apply.response.status, 409);
    assert.equal(apply.body.error.code, "CONFIG_CHANGED");
  } finally {
    client.stop();
  }
});
