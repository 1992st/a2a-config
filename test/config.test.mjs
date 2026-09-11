import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  addWorkspaceToState,
  applyWorkspaceDraft,
  buildPortStatus,
  buildRuntimeStatuses,
  envValue,
  findRunningPiProcesses,
  initializeWorkspace,
  normalizeInstanceId,
  pathsForWorkspace,
  readAppState,
  readState,
  readRuntimeRegistry,
  readWorkspace,
  renameSecretText,
  secretUpdateFromDraft,
  secretName,
  updateSecretText,
} from "../src/core.mjs";
import { joinBasePath, normalizeBasePath, stripBasePath } from "../src/server.mjs";

function temporaryWorkspace(name = "project") {
  const root = mkdtempSync(join(tmpdir(), "a2a-config-test-"));
  const workspace = join(root, name);
  mkdirSync(workspace);
  return { root, workspace, stateFile: join(root, "state.json") };
}

test("normalizes and joins configured base paths", () => {
  assert.equal(normalizeBasePath(""), "");
  assert.equal(normalizeBasePath("/a2a-config/"), "/a2a-config");
  assert.equal(joinBasePath("/api/state", "/a2a-config"), "/a2a-config/api/state");
  assert.equal(stripBasePath("/a2a-config/api/state", "/a2a-config"), "/api/state");
  assert.equal(stripBasePath("/other", "/a2a-config"), null);
});

async function mockInstall({ agentDir, pluginSource }) {
  const settingsPath = join(agentDir, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.packages = [...(settings.packages || []), pluginSource];
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { stdout: "installed", stderr: "" };
}

test("creates a workspace-local Pi and leaves project files untouched", async () => {
  const { workspace, stateFile } = temporaryWorkspace("alpha-project");
  mkdirSync(join(workspace, ".pi"));
  const projectSettingsPath = join(workspace, ".pi", "settings.json");
  const originalProjectSettings = '{"theme":"dark","a2a":{"peers":{"existing":{"url":"http://example"}}}}\n';
  writeFileSync(projectSettingsPath, originalProjectSettings);

  const result = await initializeWorkspace({
    workspacePath: workspace,
    managedWorkspaces: [],
    instances: [],
    pluginSource: "/plugins/zhangst_a2a-pi",
    piExecutable: "/bin/pi",
    runInstall: mockInstall,
    stateFile,
    probe: async () => true,
  });

  const paths = pathsForWorkspace(workspace);
  assert.equal(readFileSync(projectSettingsPath, "utf8"), originalProjectSettings);
  assert.ok(existsSync(paths.settingsPath));
  assert.ok(existsSync(join(paths.agentDir, "sessions")));
  assert.equal(result.instance.agentDir, paths.agentDir);
  assert.equal(result.instance.agentName, "alpha-project");
  assert.equal(result.instance.server.enabled, false);
  assert.equal(result.instance.server.host, "0.0.0.0");
  assert.equal(result.instance.server.port, 9910);
  assert.deepEqual(readState(stateFile), [result.instance.workspace]);
});

test("adds A2A without changing unrelated agent settings", async () => {
  const { workspace, stateFile } = temporaryWorkspace();
  const paths = pathsForWorkspace(workspace);
  mkdirSync(paths.agentDir, { recursive: true });
  writeFileSync(paths.settingsPath, '{"theme":"dark","other":{"keep":true}}\n');

  await initializeWorkspace({
    workspacePath: workspace,
    managedWorkspaces: [],
    instances: [],
    pluginSource: "/plugins/zhangst_a2a-pi",
    piExecutable: "/bin/pi",
    runInstall: mockInstall,
    stateFile,
    probe: async () => true,
  });

  const settings = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.other, { keep: true });
  assert.ok(settings.a2a);
});

test("preserves an existing A2A object exactly", async () => {
  const { workspace, stateFile } = temporaryWorkspace();
  const paths = pathsForWorkspace(workspace);
  mkdirSync(paths.agentDir, { recursive: true });
  const existingA2a = {
    instanceId: "existing",
    server: { enabled: true, host: "127.0.0.1", port: 12000, agentName: "Existing Agent" },
    custom: { untouched: [1, 2, 3] },
  };
  writeFileSync(paths.settingsPath, JSON.stringify({ a2a: existingA2a, theme: "light" }));

  const result = await initializeWorkspace({
    workspacePath: workspace,
    managedWorkspaces: [],
    instances: [],
    pluginSource: "/plugins/zhangst_a2a-pi",
    piExecutable: "/bin/pi",
    runInstall: mockInstall,
    stateFile,
    probe: async () => true,
  });

  const settings = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
  assert.deepEqual(settings.a2a, existingA2a);
  assert.equal(result.a2aPreserved, true);
});

test("generates valid and unique instance ids for non-ASCII and duplicate names", () => {
  assert.match(normalizeInstanceId("中文目录", "/tmp/中文目录"), /^pi-[a-f0-9]{8}$/);
  const first = normalizeInstanceId("project", "/tmp/a/project");
  const second = normalizeInstanceId("project", "/tmp/b/project", new Set([first]));
  assert.equal(first, "project");
  assert.match(second, /^project-[a-f0-9]{6}$/);
});

test("allocates stable distinct ports for two workspaces", async () => {
  const first = temporaryWorkspace("same-name");
  const second = temporaryWorkspace("same-name");
  await initializeWorkspace({ workspacePath: first.workspace, managedWorkspaces: [], instances: [], pluginSource: "/plugins/zhangst_a2a-pi", piExecutable: "/pi", runInstall: mockInstall, stateFile: first.stateFile, probe: async () => true });
  const firstInstance = readWorkspace(first.workspace);
  await initializeWorkspace({ workspacePath: second.workspace, managedWorkspaces: [first.workspace], instances: [firstInstance], pluginSource: "/plugins/zhangst_a2a-pi", piExecutable: "/pi", runInstall: mockInstall, stateFile: second.stateFile, probe: async () => true });
  const secondInstance = readWorkspace(second.workspace);
  assert.equal(firstInstance.server.port, 9910);
  assert.equal(secondInstance.server.port, 9911);
  assert.notEqual(firstInstance.instanceId, secondInstance.instanceId);
});

test("reports configured conflicts, fallback, and public URL mismatch", async () => {
  const base = {
    configured: true,
    server: { enabled: true, host: "0.0.0.0", port: 9910, publicUrl: "http://host:9910" },
  };
  const statuses = await buildPortStatus([
    { ...base, key: "a", workspace: "/a", instanceId: "a", agentName: "A", actualPort: 9910 },
    { ...base, key: "b", workspace: "/b", instanceId: "b", agentName: "B", actualPort: 9911 },
  ], async () => false);
  assert.ok(statuses[0].conflicts.some((entry) => entry.type === "configured-port-duplicate"));
  assert.ok(statuses[1].conflicts.some((entry) => entry.type === "fallback-port"));
  assert.ok(statuses[1].conflicts.some((entry) => entry.type === "public-url-port-mismatch"));
  assert.equal(statuses[0].severity, "warning");
  assert.equal(statuses[1].status, "fallback");
});

test("reports a configured port occupied by an unrelated process", async () => {
  const statuses = await buildPortStatus([{
    key: "a", workspace: "/a", instanceId: "a", agentName: "A", configured: true,
    server: { enabled: false, host: "0.0.0.0", port: 9910, publicUrl: "" },
  }], async () => false);
  assert.ok(statuses[0].conflicts.some((entry) => entry.type === "occupied-by-other-process"));
});

test("warns when an enabled wildcard listener has no public URL", async () => {
  const statuses = await buildPortStatus([{
    key: "a", workspace: "/a", instanceId: "a", agentName: "A", configured: true,
    server: { enabled: true, host: "0.0.0.0", port: 9910, publicUrl: "" },
  }], async () => true);
  assert.ok(statuses[0].conflicts.some((entry) => entry.type === "missing-public-url"));
  assert.equal(statuses[0].severity, "warning");
});

test("treats duplicate actual ports as an error without flagging distinct specific hosts", async () => {
  const shared = { configured: true, server: { enabled: true, port: 9910, publicUrl: "" }, actualPort: 9910 };
  const duplicates = await buildPortStatus([
    { ...shared, key: "a", workspace: "/a", instanceId: "a", agentName: "A", server: { ...shared.server, host: "0.0.0.0" } },
    { ...shared, key: "b", workspace: "/b", instanceId: "b", agentName: "B", server: { ...shared.server, host: "127.0.0.1" } },
  ], async () => false);
  assert.equal(duplicates[0].severity, "error");
  assert.equal(duplicates[1].severity, "error");

  const distinct = await buildPortStatus([
    { ...shared, key: "c", workspace: "/c", instanceId: "c", agentName: "C", server: { ...shared.server, host: "192.168.1.10" } },
    { ...shared, key: "d", workspace: "/d", instanceId: "d", agentName: "D", server: { ...shared.server, host: "192.168.1.11" } },
  ], async () => true);
  assert.equal(distinct[0].conflicts.length, 0);
  assert.equal(distinct[1].conflicts.length, 0);
});

test("port status calculation never writes workspace configuration", async () => {
  const { workspace } = temporaryWorkspace();
  const paths = pathsForWorkspace(workspace);
  mkdirSync(paths.agentDir, { recursive: true });
  writeFileSync(paths.settingsPath, JSON.stringify({ a2a: { instanceId: "demo", server: { enabled: false, host: "0.0.0.0", port: 9910 } } }));
  const before = readFileSync(paths.settingsPath, "utf8");
  await buildPortStatus([readWorkspace(workspace)], async () => true);
  assert.equal(readFileSync(paths.settingsPath, "utf8"), before);
});

test("detects Pi processes by cwd without reading their environment", () => {
  const { workspace } = temporaryWorkspace();
  const canonicalWorkspace = pathsForWorkspace(workspace).workspace;
  const running = findRunningPiProcesses([workspace], {
    platform: "darwin",
    processList: () => "  101 /usr/local/bin/pi\n  102 /usr/local/bin/node\n",
    processCwd: (pid) => pid === 101 ? workspace : "/other",
  });
  assert.deepEqual(running, [{ pid: 101, cwd: canonicalWorkspace }]);

  const instance = { key: "workspace", workspace: canonicalWorkspace, runtime: [], registry: [] };
  assert.deepEqual(buildRuntimeStatuses([instance], running)[0], {
    key: "workspace",
    status: "unconfirmed",
    pids: [101],
    loadedPids: [],
    unconfirmedPids: [101],
  });
  assert.equal(buildRuntimeStatuses([{ ...instance, runtime: [{ pid: 101 }] }], running)[0].status, "loaded");
});

test("reads secret-free plugin runtime registration", () => {
  const { workspace } = temporaryWorkspace();
  const paths = pathsForWorkspace(workspace);
  const registryDir = join(paths.agentDir, "a2a_runtime");
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(registryDir, "12345.json"), JSON.stringify({
    pid: 12345,
    cwd: workspace,
    instanceId: "project",
    startedAt: new Date().toISOString(),
    mtime: Date.now(),
  }));
  assert.deepEqual(readRuntimeRegistry(paths.agentDir, { alive: () => true }).map((entry) => entry.pid), [12345]);
});

test("keeps environment lines and supports instance id migration", () => {
  const source = "OTHER=keep\nPI_A2A_OLD='{\"server\":{\"peerTokens\":{\"remote\":\"x\"}}}'\n";
  const updated = updateSecretText(source, "old", { outbound: { peers: { next: { token: "y" } } } });
  assert.match(updated, /^OTHER=keep/m);
  assert.equal(envValue(updated, secretName("old")).outbound.peers.next.token, "y");
  const renamed = renameSecretText(updated, "old", "new");
  assert.equal(envValue(renamed, secretName("new")).server.peerTokens.remote, "x");
  assert.match(updateSecretText("", "new", { server: { peerTokens: { remote: "x" } } }), /^PI_A2A_NEW=/);
  assert.deepEqual(envValue("  PI_A2A_NEW='{}'  \n", secretName("new")), {});
});

test("retains created configuration when plugin installation fails", async () => {
  const { workspace, stateFile } = temporaryWorkspace();
  await assert.rejects(() => initializeWorkspace({
    workspacePath: workspace,
    managedWorkspaces: [],
    instances: [],
    pluginSource: "/missing-plugin",
    piExecutable: "/pi",
    runInstall: async () => { throw new Error("install failed"); },
    stateFile,
    probe: async () => true,
  }), /插件安装失败/);
  assert.ok(readWorkspace(workspace).configured);
  assert.deepEqual(readState(stateFile), [readWorkspace(workspace).workspace]);

  const retried = await initializeWorkspace({
    workspacePath: workspace,
    managedWorkspaces: [workspace],
    instances: [readWorkspace(workspace)],
    pluginSource: "/plugins/zhangst_a2a-pi",
    piExecutable: "/pi",
    runInstall: mockInstall,
    stateFile,
    probe: async () => true,
  });
  assert.equal(retried.plugin.installed, true);
});

test("applies connection drafts to the workspace-local A2A root", () => {
  const settings = { theme: "dark", a2a: { instanceId: "demo", server: { defaultWorkspaceId: "demo" }, workspaces: { demo: { root: "/project", allowedPeers: [] } } } };
  const next = applyWorkspaceDraft(settings, "/project", { incoming: [{ name: "remote", token: "unused" }], workspaceConfig: { id: "demo", root: "/project" } });
  assert.equal(next.theme, "dark");
  assert.deepEqual(next.a2a.workspaces.demo.allowedPeers, ["remote"]);
  assert.deepEqual(next.a2a.inboundPeers.remote.scopes, ["message:send", "task:read"]);
});

test("edits and removes outgoing connection settings and tokens", () => {
  const settings = {
    a2a: {
      instanceId: "demo",
      server: { defaultWorkspaceId: "demo" },
      peers: { old: { url: "http://old:9910/a2a/v1", timeoutMs: 5000 } },
      workspaces: { demo: { root: "/project", allowedPeers: [] } },
    },
  };
  const editDraft = {
    outgoing: [{ name: "new", originalName: "old", url: "http://new:9920/a2a/v1", token: "new-token", timeoutMs: 7000 }],
  };
  const edited = applyWorkspaceDraft(settings, "/project", editDraft);
  assert.equal(edited.a2a.peers.old, undefined);
  assert.deepEqual(edited.a2a.peers.new, { url: "http://new:9920/a2a/v1", timeoutMs: 7000 });
  assert.deepEqual(secretUpdateFromDraft(editDraft), {
    outbound: { peers: { old: null, new: { token: "new-token" } } },
  });

  const timeoutCleared = applyWorkspaceDraft(edited, "/project", {
    outgoing: [{ name: "new", originalName: "new", url: "http://new:9920/a2a/v1", token: "new-token", timeoutMs: null }],
  });
  assert.equal(timeoutCleared.a2a.peers.new.timeoutMs, undefined);

  const removed = applyWorkspaceDraft(edited, "/project", { removeOutgoing: ["new"] });
  assert.equal(removed.a2a.peers.new, undefined);
  assert.deepEqual(secretUpdateFromDraft({ removeOutgoing: ["new"] }), {
    outbound: { peers: { new: null } },
  });
});

test("keeps additions when a connection draft also removes other entries", () => {
  assert.deepEqual(secretUpdateFromDraft({
    outgoing: [{ name: "new", url: "http://new", token: "new-token" }],
    incoming: [{ name: "new-client", token: "new-client-token" }],
    removeOutgoing: ["old"],
    removeIncoming: ["old-client"],
  }), {
    outbound: { peers: { new: { token: "new-token" }, old: null } },
    server: { peerTokens: { "new-client": "new-client-token", "old-client": null } },
  });
});

test("renames the single workspace instead of retaining an obsolete entry", () => {
  const settings = { a2a: { instanceId: "demo", server: { defaultWorkspaceId: "old" }, workspaces: { old: { root: "/project", allowedPeers: ["remote"] } } } };
  const next = applyWorkspaceDraft(settings, "/project", { workspaceConfig: { id: "new", root: "/project" } });
  assert.equal(next.a2a.workspaces.old, undefined);
  assert.deepEqual(next.a2a.workspaces.new.allowedPeers, ["remote"]);
});

test("state stores only workspace paths", () => {
  const { workspace, stateFile } = temporaryWorkspace();
  addWorkspaceToState(workspace, stateFile);
  const stored = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["fileWorkspaces", "version", "workspaces"]);
  assert.equal(stored.version, 3);
  assert.deepEqual(stored.workspaces, [readWorkspacePath(workspace)]);
  assert.deepEqual(stored.fileWorkspaces, []);
});

test("a stale workspace record does not block adding another workspace", () => {
  const { root, workspace, stateFile } = temporaryWorkspace();
  writeFileSync(stateFile, JSON.stringify({ version: 2, workspaces: [join(root, "missing")] }));
  addWorkspaceToState(workspace, stateFile);
  assert.deepEqual(readState(stateFile), [join(root, "missing"), readWorkspacePath(workspace)]);
});

test("rejects a malformed state file instead of overwriting it as empty state", () => {
  const { stateFile } = temporaryWorkspace();
  writeFileSync(stateFile, "{broken");
  assert.throws(() => readAppState(stateFile), /状态文件不是有效 JSON/);
});

function readWorkspacePath(workspace) {
  return pathsForWorkspace(workspace).workspace;
}
