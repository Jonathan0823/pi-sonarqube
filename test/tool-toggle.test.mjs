import assert from "node:assert/strict";
import { test } from "node:test";

import sonarqube from "../dist/index.js";

const ENABLED_ENTRY_TYPE = "sonarqube-tool-enabled";

function createHarness(entries = [], hasUI = false) {
  const active = new Set(["read", "sonarqube", "bash"]);
  const handlers = new Map();
  const commands = new Map();
  const appended = [];
  const notices = [];

  sonarqube({
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool() {},
    getActiveTools() {
      return [...active];
    },
    setActiveTools(names) {
      active.clear();
      for (const name of names) active.add(name);
    },
    appendEntry(customType, data) {
      appended.push({ customType, data });
    },
  });

  const ctx = {
    hasUI,
    cwd: process.cwd(),
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => [],
    },
    ui: {
      setStatus() {},
      notify(message, level) {
        notices.push({ message, level });
      },
      addAutocompleteProvider() {},
    },
  };

  return { active, appended, commands, ctx, handlers, notices };
}

test("SonarQube tool is off by default while its slash command remains available", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")({}, harness.ctx);

  assert.equal(harness.active.has("sonarqube"), false);
  assert.ok(harness.commands.has("sonarqube"));
  assert.equal(harness.commands.has("sonarqube-tools"), false);
});

test("disabled startup notice is actionable and only shown when disabled", async () => {
  const disabled = createHarness([], true);
  await disabled.handlers.get("session_start")({}, disabled.ctx);
  assert.deepEqual(disabled.notices, [
    {
      message: "SonarQube tool is disabled; run /sonarqube on to enable it",
      level: "info",
    },
  ]);

  const enabled = createHarness(
    [{ type: "custom", customType: ENABLED_ENTRY_TYPE, data: { on: true } }],
    true,
  );
  await enabled.handlers.get("session_start")({}, enabled.ctx);
  assert.equal(enabled.active.has("sonarqube"), true);
  assert.deepEqual(enabled.notices, []);
});

test("toggle command enables/disables the tool and records session state", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")({}, harness.ctx);
  const command = harness.commands.get("sonarqube");

  await command.handler("on", harness.ctx);
  assert.equal(harness.active.has("sonarqube"), true);
  assert.deepEqual(harness.appended.at(-1), {
    customType: ENABLED_ENTRY_TYPE,
    data: { on: true },
  });

  await command.handler("off", harness.ctx);
  assert.equal(harness.active.has("sonarqube"), false);
  assert.deepEqual(harness.appended.at(-1), {
    customType: ENABLED_ENTRY_TYPE,
    data: { on: false },
  });

  await command.handler("status", harness.ctx);
  assert.equal(harness.active.has("sonarqube"), false);
  assert.equal(harness.appended.length, 2);
  assert.match(
    harness.notices.at(-1).message,
    /run \/sonarqube on to enable it/,
  );
});

test("operational slash commands are blocked while disabled", async () => {
  const harness = createHarness([], true);
  await harness.handlers.get("session_start")({}, harness.ctx);
  const command = harness.commands.get("sonarqube");

  for (const args of [
    "analyze",
    "issues",
    "metrics",
    "duplications",
    "open target 1",
  ]) {
    await command.handler(args, harness.ctx);
    assert.deepEqual(harness.notices.at(-1), {
      message:
        "SonarQube is disabled; run /sonarqube on before scanning or querying results",
      level: "warning",
    });
  }

  assert.equal(harness.active.has("sonarqube"), false);
  await command.handler("", harness.ctx);
  assert.match(harness.notices.at(-1).message, /SonarQube commands:/);
});

test("toggle state is restored from the latest session entry", async () => {
  const harness = createHarness([
    { type: "custom", customType: ENABLED_ENTRY_TYPE, data: { on: true } },
    { type: "custom", customType: ENABLED_ENTRY_TYPE, data: { on: false } },
    { type: "custom", customType: ENABLED_ENTRY_TYPE, data: { on: true } },
  ]);

  await harness.handlers.get("session_start")({}, harness.ctx);
  assert.equal(harness.active.has("sonarqube"), true);
});
