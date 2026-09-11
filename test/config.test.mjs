import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyWorkspaceDraft, buildPortStatus, buildRuntimeStatuses, envValue,
  hasA2aPlugin, initializeWorkspace, normalizeInstanceId, readAgentDirectories,
  readAppState, readRuntimeRegistry, readWorkspace, renameSecretText,
  secretName, secretUpdateFromDraft, updateSecretText, writeAppState,
} from "../src/core.mjs";
import { joinBasePath, normalizeBasePath, stripBasePath } from "../src/server.mjs";

function fixture(name = "project") {
  const root = mkdtempSync(join(tmpdir(), "a2a-config-system-"));
  let workspace = join(root, name);
  const agentDir = join(root, "system-agent");
  mkdirSync(workspace);
  workspace = realpathSync(workspace);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    theme: "dark",
    packages: ["/opt/plugins/zhangst_a2a-pi"],
  }, null, 2));
  return { root, workspace, agentDir, stateFile: join(root, "state.json") };
}

test("normalizes configured base paths", () => {
  assert.equal(normalizeBasePath("/a2a-config/"), "/a2a-config");
  assert.equal(joinBasePath("/api/state", "/a2a-config"), "/a2a-config/api/state");
  assert.equal(stripBasePath("/a2a-config/api/state", "/a2a-config"), "/api/state");
  assert.equal(stripBasePath("/other", "/a2a-config"), null);
});

test("creates a system Pi profile without creating workspace agent files", async () => {
  const item = fixture("alpha-project");
  mkdirSync(join(item.workspace, ".pi"));
  const projectSettings = join(item.workspace, ".pi", "settings.json");
  const original = '{"theme":"light","a2a":{"peers":{"project":{"url":"http://project"}}}}\n';
  writeFileSync(projectSettings, original);
  const result = await initializeWorkspace({ workspacePath: item.workspace, agentDir: item.agentDir, instances: [], probe: async () => true });
  const settings = JSON.parse(readFileSync(join(item.agentDir, "settings.json"), "utf8"));
  assert.ok(settings.a2a.profiles[result.instance.workspace]);
  assert.equal(settings.theme, "dark");
  assert.equal(readFileSync(projectSettings, "utf8"), original);
  assert.equal(existsSync(join(item.workspace, ".pi", "agent")), false);
  assert.equal(result.instance.startCommand.includes("PI_CODING_AGENT_DIR"), false);
});

test("preserves an existing system profile and unknown fields", async () => {
  const item = fixture();
  const existing = { instanceId: "existing", server: { enabled: true, port: 12000 }, custom: { keep: true } };
  const settingsPath = join(item.agentDir, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.a2a = { profiles: { [item.workspace]: existing }, globalUnknown: 1 };
  writeFileSync(settingsPath, JSON.stringify(settings));
  const result = await initializeWorkspace({ workspacePath: item.workspace, agentDir: item.agentDir, instances: [], probe: async () => true });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).a2a.profiles[item.workspace], existing);
  assert.equal(result.a2aPreserved, true);
});

test("merges project A2A using the plugin project allowlist", () => {
  const item = fixture();
  const settingsPath = join(item.agentDir, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.a2a = { profiles: { [item.workspace]: { instanceId: "system", server: { enabled: true, host: "0.0.0.0", port: 9910 }, peers: { global: { url: "http://global" } } } } };
  writeFileSync(settingsPath, JSON.stringify(settings));
  mkdirSync(join(item.workspace, ".pi"));
  writeFileSync(join(item.workspace, ".pi", "settings.json"), JSON.stringify({ a2a: { instanceId: "blocked", server: { enabled: false, portFallback: 3 }, peers: { project: { url: "http://project" } } } }));
  const instance = readWorkspace(item.workspace, item.agentDir);
  assert.equal(instance.instanceId, "system");
  assert.equal(instance.server.enabled, true);
  assert.equal(instance.server.portFallback, 3);
  assert.deepEqual(instance.peers.map((peer) => peer.name).sort(), ["global", "project"]);
});

test("reports configured, available, and loaded plugin states separately", () => {
  const item = fixture();
  const pluginRoot = join(item.root, "plugin", "zhangst_a2a-pi");
  mkdirSync(pluginRoot, { recursive: true });
  const source = "../plugin/zhangst_a2a-pi";
  assert.deepEqual(hasA2aPlugin({ packages: [source] }, item.agentDir, true), {
    configured: true, available: true, loaded: true, source, installed: true,
  });
  assert.equal(hasA2aPlugin({ packages: ["../missing/pi-a2a"] }, item.agentDir).available, false);
});

test("lists profiles from registered agent directories", () => {
  const item = fixture();
  const settingsPath = join(item.agentDir, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.a2a = { profiles: { [item.workspace]: { instanceId: "alpha", server: { port: 9910 } } } };
  writeFileSync(settingsPath, JSON.stringify(settings));
  assert.equal(readAgentDirectories([item.agentDir])[0].instanceId, "alpha");
});

test("retains old workspace state as explicit legacy data", () => {
  const item = fixture();
  writeFileSync(item.stateFile, JSON.stringify({ version: 3, workspaces: [item.workspace], fileWorkspaces: [] }));
  const state = readAppState(item.stateFile);
  assert.deepEqual(state.legacyWorkspaces, [item.workspace]);
  writeAppState(state, item.stateFile);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(item.stateFile, "utf8"))).sort(), ["fileWorkspaces", "legacyWorkspaces", "manualAgentDirs", "migratedLegacyWorkspaces", "version"]);
});

test("applies drafts only inside the selected system profile", () => {
  const settings = { theme: "dark", a2a: { profiles: { "/project": { instanceId: "demo", server: { defaultWorkspaceId: "demo" }, workspaces: { demo: { root: "/project", allowedPeers: [] } } } }, untouched: true } };
  const next = applyWorkspaceDraft(settings, "/project", { incoming: [{ name: "remote", token: "unused" }], workspaceConfig: { id: "demo", root: "/project" } });
  assert.equal(next.theme, "dark");
  assert.equal(next.a2a.untouched, true);
  assert.deepEqual(next.a2a.profiles["/project"].workspaces.demo.allowedPeers, ["remote"]);
});

test("keeps secret environment lines and supports instance migration", () => {
  const source = "OTHER=keep\nPI_A2A_OLD='{\"server\":{\"peerTokens\":{\"remote\":\"x\"}}}'\n";
  const updated = updateSecretText(source, "old", { outbound: { peers: { next: { token: "y" } } } });
  assert.equal(envValue(updated, secretName("old")).outbound.peers.next.token, "y");
  assert.equal(envValue(renameSecretText(updated, "old", "new"), secretName("new")).server.peerTokens.remote, "x");
  assert.deepEqual(secretUpdateFromDraft({ removeOutgoing: ["next"] }), { outbound: { peers: { next: null } } });
});

test("detects runtime registrations and duplicate ports", async () => {
  assert.match(normalizeInstanceId("中文目录", "/tmp/中文目录"), /^pi-[a-f0-9]{8}$/);
  const item = fixture();
  const runtime = join(item.agentDir, "a2a_runtime");
  mkdirSync(runtime);
  writeFileSync(join(runtime, "123.json"), JSON.stringify({ pid: 123, cwd: item.workspace, instanceId: "project" }));
  assert.equal(readRuntimeRegistry(item.agentDir, { alive: () => true })[0].pid, 123);
  assert.equal(buildRuntimeStatuses([{ key: "x", workspace: item.workspace, runtime: [{ pid: 123 }], registry: [] }], [])[0].status, "loaded");
  const shared = { configured: true, server: { enabled: true, host: "0.0.0.0", port: 9910, publicUrl: "" } };
  const statuses = await buildPortStatus([
    { ...shared, key: "a", workspace: "/a", instanceId: "a", agentName: "A" },
    { ...shared, key: "b", workspace: "/b", instanceId: "b", agentName: "B" },
  ], async () => true);
  assert.ok(statuses.every((status) => status.conflicts.some((entry) => entry.type === "configured-port-duplicate")));
});
