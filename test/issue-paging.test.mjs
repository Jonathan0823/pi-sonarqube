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

async function run(issues, request, mode = "MQR") {
  const dir = await mkdtemp(join(tmpdir(), "pi-sonarqube-paging-"));
  const original = globalThis.fetch;
  try {
    await mkdir(join(dir, ".host"), { recursive: true });
    await writeFile(
      join(dir, "sonar-project.properties"),
      "sonar.projectKey=demo\n",
    );
    await writeFile(
      join(dir, ".host", "sonarqube.json"),
      JSON.stringify({
        serverUrl: `http://core-${mode.toLowerCase()}.test`,
        projectKey: "demo",
      }),
    );
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/issues/search") {
        return json({ total: issues.length, issues });
      }
      if (url.pathname === "/api/v2/clean-code-policy/mode") {
        return json({ mode });
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

const mk = (i, file = "src/a.ts", rule = "ts:S1", severity = "MAJOR") => ({
  key: "K" + i,
  rule,
  severity,
  message: "msg " + i,
  component: "demo:" + file,
  line: i,
  status: "OPEN",
});

const many = (n) => Array.from({ length: n }, (_, i) => mk(i + 1));

test("limit and offset slice the list and the header shows the range", async () => {
  const r = await run(many(30), { action: "issues", limit: 5, offset: 10 });
  assert.match(r.text, /30 issues \(showing 11-15\)/);
  assert.match(r.text, /K11 /);
  assert.match(r.text, /K15 /);
  assert.doesNotMatch(r.text, /K10 |K16 /);
});

test("default limit is 10", async () => {
  const r = await run(many(12), { action: "issues" });
  assert.match(r.text, /showing 1-10/);
  assert.match(r.text, /K10 /);
  assert.doesNotMatch(r.text, /K11 /);
});

test("cut-off list shows a more indication and breakdown of the rest", async () => {
  const issues = [
    mk(1, "src/a.ts", "ts:S1", "CRITICAL"),
    mk(2, "src/a.ts", "ts:S1", "CRITICAL"),
    mk(3, "src/b.ts", "ts:S2", "MAJOR"),
    mk(4, "src/b.ts", "ts:S2", "MAJOR"),
    mk(5, "src/c.ts", "ts:S3", "MINOR"),
  ];
  const r = await run(issues, { action: "issues", limit: 2 }, "STANDARD");
  assert.match(r.text, /3 more/);
  assert.match(r.text, /remaining/);
  assert.match(r.text, /MAJOR 2/);
  assert.match(r.text, /MINOR 1/);
  assert.match(r.text, /ts:S2.2/);
  assert.match(r.text, /src\/b\.ts.2/);
  assert.doesNotMatch(r.text, /CRITICAL 2/);
});

test("breakdown severity labels follow MQR mode", async () => {
  const issues = [
    mk(1),
    mk(2, "src/a.ts", "ts:S1", "CRITICAL"),
    mk(3, "src/a.ts", "ts:S1", "MINOR"),
  ];
  const r = await run(issues, { action: "issues", limit: 1 }, "MQR");
  assert.match(r.text, /HIGH 1/);
  assert.match(r.text, /LOW 1/);
  assert.doesNotMatch(r.text, /CRITICAL 1|MINOR 1/);
});

test("breakdown lists at most 5 rules and 5 files", async () => {
  const issues = Array.from({ length: 9 }, (_, i) =>
    mk(i + 1, "src/f" + i + ".ts", "ts:R" + i),
  );
  const r = await run(issues, { action: "issues", limit: 1 });
  const rest = r.text.split("remaining")[1];
  assert.equal((rest.match(/ts:R\d/g) ?? []).length, 5);
  assert.equal((rest.match(/f\d\.ts/g) ?? []).length, 5);
});

test("no more indication or breakdown when everything fits", async () => {
  const r = await run(many(3), { action: "issues", limit: 3 });
  assert.doesNotMatch(r.text, /more|remaining/);
});

test("analyze-style paging also applies to offset past the end", async () => {
  const r = await run(many(3), { action: "issues", offset: 5 });
  assert.match(r.text, /3 issues/);
  assert.doesNotMatch(r.text, /remaining/);
});

test("invalid limit and offset are rejected", async () => {
  await assert.rejects(run(many(3), { action: "issues", limit: 0 }), /limit/);
  await assert.rejects(run(many(3), { action: "issues", limit: 1.5 }), /limit/);
  await assert.rejects(
    run(many(3), { action: "issues", offset: -1 }),
    /offset/,
  );
});

test("limit above the cap is clamped to 100", async () => {
  const r = await run(many(150), { action: "issues", limit: 1000 });
  assert.match(r.text, /showing 1-100/);
});
