import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSonarAction } from "../dist/core/actions.js";

const json = (body) => ({
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

async function run(issues, request) {
  const dir = await mkdtemp(join(tmpdir(), "pi-sonarqube-compact-"));
  const original = globalThis.fetch;
  try {
    await mkdir(join(dir, ".host"), { recursive: true });
    await writeFile(
      join(dir, "sonar-project.properties"),
      "sonar.projectKey=demo\n",
    );
    await writeFile(
      join(dir, ".host", "sonarqube.json"),
      JSON.stringify({ serverUrl: "http://core.test", projectKey: "demo" }),
    );
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/issues/search") {
        return json({ total: issues.length, issues });
      }
      if (url.pathname === "/api/v2/clean-code-policy/mode") {
        return json({ mode: "MQR" });
      }
      return json({ rule: { name: "Some Rule Name" }, components: [] });
    };
    return await runSonarAction(request, {
      cwd: dir,
      configDirName: ".host",
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      store: { get: () => undefined, remember() {}, persist() {} },
    });
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
}

const mk = (key, file, line, rule = "ts:S1") => ({
  key,
  rule,
  severity: "MAJOR",
  message: "msg " + key,
  component: "demo:" + file,
  line,
  status: "OPEN",
});

test("issues are grouped by file with compact lines and trimmed header", async () => {
  const r = await run(
    [mk("K1", "src/a.ts", 3), mk("K2", "src/b.ts", 4), mk("K3", "src/a.ts", 9)],
    { action: "issues" },
  );
  assert.equal(r.text.split("src/a.ts").length - 1, 1);
  assert.match(r.text, /K1.*MAJOR.*:3.*ts:S1.*msg K1/);
  assert.match(r.text, /K3.*:9/);
  assert.doesNotMatch(r.text, /Some Rule Name/);
  assert.doesNotMatch(r.text, /Server:|Base dir:|core\.test/);
  assert.doesNotMatch(r.text, /^\s*0?1\. /m);
  assert.match(r.text, /demo/);
  assert.match(r.text, /3/);
});

test("empty result names project", async () => {
  const r = await run([], { action: "issues" });
  assert.match(r.text, /no .*issues/i);
  assert.match(r.text, /demo/);
});
