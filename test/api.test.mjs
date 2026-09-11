import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function startTestServer(root, basePath = "") {
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
  const fakeRclone = join(root, "rclone");
  writeFileSync(fakeRclone, `#!/usr/bin/env node
import { createServer } from "node:net";
if (process.argv[2] === "version") { console.log("rclone vtest"); process.exit(0); }
if (process.argv[2] === "serve") {
  if (!process.env.RCLONE_USER || !process.env.RCLONE_PASS) process.exit(2);
  if (process.env.OPENAI_API_KEY || process.env.A2A_CONFIG_ADMIN_TOKEN) process.exit(3);
  const address = process.argv[process.argv.indexOf("--addr") + 1];
  const port = Number(address.split(":").at(-1));
  const server = createServer();
  server.listen(port, "127.0.0.1");
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
`);
  chmodSync(fakeRclone, 0o755);
  const fakeSshKeygen = join(root, "ssh-keygen");
  writeFileSync(fakeSshKeygen, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const output = process.argv[process.argv.indexOf("-f") + 1];
if (process.argv.includes("-lf")) console.log("256 SHA256:test-fingerprint host (ED25519)");
else { writeFileSync(output, "private-key"); writeFileSync(output + ".pub", "ssh-ed25519 AAAATEST host\\n"); }
`);
  chmodSync(fakeSshKeygen, 0o755);
  const server = spawn(process.execPath, [resolve("src/server.mjs"), "--plugin-source", "/plugins/zhangst_a2a-pi"], {
    cwd: resolve("."),
    env: {
      ...process.env,
      A2A_CONFIG_PI: fakePi,
      A2A_CONFIG_RCLONE: fakeRclone,
      A2A_CONFIG_SSH_KEYGEN: fakeSshKeygen,
      A2A_CONFIG_STATE_FILE: join(root, "state.json"),
      OPENAI_API_KEY: "must-not-reach-rclone",
      A2A_CONFIG_ADMIN_TOKEN: "must-not-reach-rclone",
      A2A_CONFIG_BASE_PATH: basePath,
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
  const rootResponse = await fetch(new URL(`${basePath}/`.replace(/^\//, ""), baseUrl));
  const cookie = rootResponse.headers.get("set-cookie")?.split(";")[0];
  return {
    baseUrl,
    cookie,
    server,
    async request(path, options = {}) {
      const response = await fetch(new URL(`${basePath}${path}`.replace(/^\//, ""), baseUrl), {
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

test("serves the complete application under a configured base path", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-config-base-path-"));
  const client = await startTestServer(root, "/a2a-config");
  try {
    const page = await fetch(new URL("a2a-config/", client.baseUrl));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /content="\/a2a-config"/);
    assert.match(html, /href="\/a2a-config\/styles\.css"/);
    assert.match(page.headers.get("set-cookie") || "", /Path=\/a2a-config/);
    assert.equal((await fetch(new URL("a2a-config/styles.css", client.baseUrl))).status, 200);
    assert.equal((await fetch(new URL("a2a-config/app.js", client.baseUrl))).status, 200);
    const state = await client.request("/api/state");
    assert.equal(state.response.status, 200);
  } finally {
    client.stop();
  }
});

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

test("file workspace lifecycle and agent query use independent state", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-config-files-"));
  const agentWorkspace = join(root, "agent");
  const fileRoot = join(root, "shared-files");
  mkdirSync(agentWorkspace);
  mkdirSync(fileRoot);
  const client = await startTestServer(root);
  try {
    const started = await client.request("/api/workspaces", { method: "POST", body: JSON.stringify({ path: agentWorkspace }) });
    assert.equal((await waitForOperation(client, started.body.id)).status, "complete");
    const state = await client.request("/api/state");
    const agent = state.body.workspaces[0];
    const inspected = await client.request("/api/file-workspaces/inspect", { method: "POST", body: JSON.stringify({ root: fileRoot }) });
    assert.equal(inspected.response.status, 200);
    assert.equal(inspected.body.dependencies.ready, true);

    const created = await client.request("/api/file-workspaces", {
      method: "POST",
      body: JSON.stringify({
        root: fileRoot,
        name: "共享文件",
        username: "shared-files",
        password: "plain-password",
        port: inspected.body.suggestedPort,
        publicUrl: `sftp://127.0.0.1:${inspected.body.suggestedPort}`,
        boundAgentKeys: [agent.key],
      }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.match(created.body.id, /^files-shared-files-[a-f0-9]{10}$/);
    let files;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      files = await client.request("/api/file-workspaces");
      if (files.body.fileWorkspaces[0]?.status.state === "running") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assert.equal(files.body.fileWorkspaces[0].status.state, "running");

    const info = await client.request(`/api/agent/file-workspaces?agentId=${agent.instanceId}`);
    assert.equal(info.body.fileWorkspaces[0].password, "plain-password");
    assert.equal(info.body.fileWorkspaces[0].hostPublicKey, "ssh-ed25519 AAAATEST");

    const disabled = await client.request(`/api/file-workspaces/${created.body.id}/disable`, { method: "POST", body: "{}" });
    assert.equal(disabled.body.enabled, false);
    const invalidRestart = await client.request(`/api/file-workspaces/${created.body.id}/restart`, { method: "POST", body: "{}" });
    assert.equal(invalidRestart.response.status, 400);
    assert.match(invalidRestart.body.error.message, /请先启用/);
    const afterDisable = await client.request(`/api/agent/file-workspaces?agentId=${agent.instanceId}`);
    assert.deepEqual(afterDisable.body.fileWorkspaces, []);
    const persisted = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    assert.equal(persisted.fileWorkspaces.length, 1);
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
