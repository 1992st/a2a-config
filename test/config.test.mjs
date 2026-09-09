import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applySettingsDraft, effectiveInstance, envValue, normalizeAgentDir, renameSecretText, secretName, updateSecretText } from "../src/server.mjs";

test("validates agentDir and reads one profile without duplicating A2A data", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-config-test-"));
  const cwd = join(root, "project");
  writeFileSync(join(root, "settings.json"), JSON.stringify({ other: { keep: true }, a2a: { profiles: { [cwd]: { instanceId: "demo", inboundPeers: { remote: {} } } } } }));
  writeFileSync(join(root, ".env.local"), "OTHER=keep\nPI_A2A_DEMO='{\"server\":{\"peerTokens\":{\"remote\":\"token\"}}}'\n");
  const real = normalizeAgentDir(root);
  const instance = effectiveInstance(real, cwd);
  assert.equal(instance.instanceId, "demo");
  assert.equal(instance.inbound[0].token, "token");
  assert.equal(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).other.keep, true);
});

test("updates only the selected environment variable and preserves other lines", () => {
  const text = "OTHER=keep\nPI_A2A_DEMO='{\"outbound\":{\"peers\":{\"old\":{\"token\":\"x\"}}}}'\n";
  const next = updateSecretText(text, "demo", { outbound: { peers: { fresh: { token: "y" } } } });
  assert.match(next, /^OTHER=keep/m);
  assert.deepEqual(envValue(next, secretName("demo")).outbound.peers, { old: { token: "x" }, fresh: { token: "y" } });
});

test("removes an inbound connection from settings and secret data", () => {
  const settings = { a2a: { profiles: { "/project": { inboundPeers: { remote: { scopes: ["message:send"] } }, workspaces: { project: { root: "/project", allowedPeers: ["remote"] } } } } } };
  const next = applySettingsDraft(settings, "/project", { removeIncoming: ["remote"] });
  const profile = next.a2a.profiles["/project"];
  assert.deepEqual(profile.inboundPeers, {});
  assert.deepEqual(profile.workspaces.project.allowedPeers, []);
});

test("does not create an empty secret variable for ordinary settings edits", async () => {
  const source = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(source, /const secretUpdate = secretUpdateFromDraft/);
  assert.doesNotMatch(source, /nextEnv = updateSecretText\(env\.text/);
});

test("renames an instance secret without overwriting an existing variable", () => {
  const text = "PI_A2A_OLD='{\"server\":{\"peerTokens\":{\"remote\":\"token\"}}}'\n";
  const renamed = renameSecretText(text, "old", "new");
  assert.equal(envValue(renamed, secretName("new")).server.peerTokens.remote, "token");
  assert.throws(() => renameSecretText(`${text}PI_A2A_NEW='{}'\n`, "old", "new"), /已存在/);
});

test("exposes a stable instance key for API selection", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-config-key-"));
  const cwd = join(root, "project");
  writeFileSync(join(root, "settings.json"), JSON.stringify({ a2a: { profiles: { [cwd]: { instanceId: "demo" } } } }));
  const instance = effectiveInstance(normalizeAgentDir(root), cwd);
  assert.match(instance.key, /^[a-f0-9]{16}$/);
});
