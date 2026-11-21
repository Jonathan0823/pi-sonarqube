import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSonarAction } from "../dist/core/actions.js";

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  async json() {
    return body;
  },
  async text() {
    return JSON.stringify(body);
  },
});

test("core sources import nothing from Pi packages", async () => {
  const dir = new URL("../src/core/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
  assert.ok(files.includes("actions.ts"));
  for (const name of files) {
    const text = await readFile(new URL(name, dir), "utf8");
    assert.doesNotMatch(text, /@earendil-works|typebox/, name);
  }
});

test("analyze runs through the injected runner, config dir and store", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-sonarqube-core-"));
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(join(projectDir, ".host"));
    await writeFile(
      join(projectDir, ".host", "sonarqube.json"),
      JSON.stringify({ serverUrl: "http://core.test", projectKey: "demo" }),
    );
    await mkdir(join(projectDir, ".scannerwork"));
    await writeFile(
      join(projectDir, ".scannerwork", "report-task.txt"),
      "dashboardUrl=http://core.test/dashboard\n",
    );
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/issues/search") {
        return jsonResponse({ total: 0, issues: [] });
      }
      if (url.pathname === "/api/v2/clean-code-policy/mode") {
        return jsonResponse({ mode: "STANDARD" });
      }
      return jsonResponse({
        component: { measures: [] },
        paging: { total: 0 },
      });
    };

    const calls = [];
    const persisted = [];
    const remembered = [];
    const phases = [];
    const result = await runSonarAction(
      { action: "analyze", path: projectDir },
      {
        cwd: projectDir,
        configDirName: ".host",
        exec: async (command, args) => {
          calls.push([command, ...args]);
          return { stdout: "/usr/bin/sonar-scanner", stderr: "", code: 0 };
        },
        store: {
          get: () => undefined,
          remember: (state) => remembered.push(state),
          persist: (state) => persisted.push(state),
        },
        startProgress: () => ({
          setPhase: (phase) => phases.push(phase),
          stop: () => phases.push("stop"),
        }),
      },
    );

    assert.ok(calls.some((call) => call[0] === "sonar-scanner"));
    assert.equal(persisted.length, 1);
    assert.equal(remembered.length, 1);
    assert.equal(result.details, persisted[0]);
    assert.match(result.text, /demo/);
    assert.equal(phases.at(-1), "stop");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("issues without a prior analysis reports a soft result, bad input throws", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-sonarqube-core-"));
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(join(projectDir, ".host"));
    await writeFile(
      join(projectDir, ".host", "sonarqube.json"),
      JSON.stringify({ serverUrl: "http://core.test", projectKey: "demo" }),
    );
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    const env = {
      cwd: projectDir,
      configDirName: ".host",
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      store: { get: () => undefined, remember() {}, persist() {} },
    };

    await assert.rejects(
      runSonarAction({ action: "issues", path: projectDir }, env),
      /offline/,
    );
    await assert.rejects(
      runSonarAction({ action: "issues", issueKeys: ["a"] }, env),
      /only be used with the open action/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectDir, { recursive: true, force: true });
  }
});
