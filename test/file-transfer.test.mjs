import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chooseFilePort, defaultPublicHosts, FileTransferManager, fileWorkspaceId, normalizeFileRoot, validateFileWorkspace } from "../src/file-transfer.mjs";
import { writeAppState } from "../src/core.mjs";

test("normalizes existing writable roots and rejects missing roots", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-files-"));
  assert.equal(normalizeFileRoot(root), realpathSync(root));
  assert.throws(() => normalizeFileRoot(join(root, "missing")), /不存在/);
  const file = join(root, "file.txt");
  writeFileSync(file, "not a directory");
  assert.throws(() => normalizeFileRoot(file), /必须是目录/);
});

test("validates one or more agent bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-files-"));
  const agents = [{ key: "a" }, { key: "b" }];
  const value = validateFileWorkspace({
    root,
    name: "Files",
    username: "files-user",
    password: "plain-password",
    port: 2022,
    publicUrl: "sftp://host:2022",
    boundAgentKeys: ["a", "a", "unknown"],
  }, agents);
  assert.deepEqual(value.boundAgentKeys, ["a"]);
  assert.throws(() => validateFileWorkspace({ ...value, boundAgentKeys: [] }, agents), /至少关联一个 Agent/);
  assert.throws(() => validateFileWorkspace({ ...value, password: "x".repeat(1025) }, agents), /1024/);
});

test("builds stable file workspace ids from the directory name and path", () => {
  assert.match(fileWorkspaceId("/data/Audio Files"), /^files-audio-files-[a-f0-9]{10}$/);
  assert.equal(fileWorkspaceId("/data/Audio Files"), fileWorkspaceId("/data/Audio Files"));
  assert.notEqual(fileWorkspaceId("/data/Audio Files"), fileWorkspaceId("/other/Audio Files"));
});

test("selects public hosts by A2A, Tailscale, then a unique LAN address", () => {
  const hosts = defaultPublicHosts([
    { server: { publicUrl: "http://agent.example:9910" } },
  ], {
    interfaces: { ethernet: [{ family: "IPv4", internal: false, address: "192.168.1.20" }] },
    run: () => "100.64.0.10\n",
  });
  assert.deepEqual(hosts, [
    { host: "agent.example", source: "a2a-public-url" },
    { host: "100.64.0.10", source: "tailscale" },
    { host: "192.168.1.20", source: "lan" },
  ]);
});

test("allocates SFTP ports without reusing configured or occupied ports", async () => {
  const seen = [];
  const port = await chooseFilePort([{ port: 2022 }], 2022, async (_host, candidate) => {
    seen.push(candidate);
    return candidate === 2024;
  });
  assert.equal(port, 2024);
  assert.deepEqual(seen, [2023, 2024]);
});

test("reports duplicate configured SFTP ports for both file spaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-files-state-"));
  const stateFile = join(root, "state.json");
  writeAppState({
    workspaces: [],
    fileWorkspaces: [
      { id: "a", name: "A", listenHost: "0.0.0.0", port: 2022 },
      { id: "b", name: "B", listenHost: "127.0.0.1", port: 2022 },
    ],
  }, stateFile);
  const manager = new FileTransferManager({ stateFile, probe: async () => true });
  const statuses = await manager.monitoredStatuses();
  assert.deepEqual(statuses.map((entry) => entry.state), ["port-conflict", "port-conflict"]);
});

test("does not restart a disabled file workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-files-state-"));
  const stateFile = join(root, "state.json");
  writeAppState({
    workspaces: [],
    fileWorkspaces: [{ id: "disabled", name: "Disabled", enabled: false }],
  }, stateFile);
  const manager = new FileTransferManager({ stateFile });
  await assert.rejects(() => manager.restart("disabled"), /请先启用/);
});
