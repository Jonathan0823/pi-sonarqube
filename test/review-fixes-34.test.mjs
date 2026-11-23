import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sonarqube from "../dist/index.js";
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

const raw = (key, file) => ({
  key,
  rule: "ts:S1",
  severity: "MAJOR",
  message: "m " + key,
  component: "demo:" + file,
  line: 1,
  status: "OPEN",
});

async function withProject(run) {
  const dir = await mkdtemp(join(tmpdir(), "pi-sonarqube-rf34-"));
  const original = globalThis.fetch;
  try {
    await mkdir(join(dir, ".host"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "alpha 1\nalpha 2\n");
    await writeFile(join(dir, "src/b.ts"), "beta 1\nbeta 2\n");
    await writeFile(
      join(dir, ".host", "sonarqube.json"),
      JSON.stringify({ serverUrl: "http://rf34.test", projectKey: "demo" }),
    );
    await run(dir);
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
}

const env = (dir, extra = {}) => ({
  cwd: dir,
  configDirName: ".host",
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  store: { get: () => undefined, remember() {}, persist() {} },
  ...extra,
});

function fakeServer(issues) {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/issues/search") {
      return json({ total: issues.length, issues });
    }
    if (url.pathname === "/api/v2/clean-code-policy/mode") {
      return json({ mode: "STANDARD" });
    }
    return json({ rule: { name: "n" } });
  };
}

test("issues with issueKeys reports keys that were not found", async () => {
  await withProject(async (dir) => {
    fakeServer([raw("K1", "src/a.ts")]);
    const result = await runSonarAction(
      { action: "issues", issueKeys: ["K1", "GONE", "ALSO"] },
      env(dir),
    );
    assert.match(result.text, /not found: GONE, ALSO/);
    assert.doesNotMatch(result.text, /not found: K1/);
  });
});

test("Pi by-key open keeps requested key order and reports missing keys", async () => {
  await withProject(async (dir) => {
    fakeServer([raw("A", "src/a.ts"), raw("B", "src/b.ts")]);
    const result = await runSonarAction(
      { action: "open", issueKeys: ["B", "NOPE", "A"] },
      env(dir),
    );
    assert.ok(result.text.indexOf("[B]") < result.text.indexOf("[A]"));
    assert.match(result.text, /NOPE/);
    assert.match(result.text, /not found/);
    assert.deepEqual(result.details.missingIssueKeys, ["NOPE"]);
  });
});

test("Pi positional open selects the nth issue and reports a missing one", async () => {
  await withProject(async (dir) => {
    fakeServer([raw("A", "src/a.ts"), raw("B", "src/b.ts")]);
    const second = await runSonarAction(
      { action: "open", issueIndex: 2 },
      env(dir),
    );
    assert.equal(second.details.selectedIssue.key, "B");
    assert.match(second.text, /beta 1/);
    const missing = await runSonarAction(
      { action: "open", issueIndex: 9 },
      env(dir),
    );
    assert.equal(missing.details.code, "issue_not_found");
  });
});

test("Pi schema omits open/issueIndex, guides legacy calls, exposes fileIndex; paging is uncapped", async () => {
  let tool;
  sonarqube({
    on() {},
    registerCommand() {},
    registerTool(definition) {
      tool = definition;
    },
  });
  const props = tool.parameters.properties;
  assert.ok(!props.action.enum.includes("open"));
  assert.equal(props.issueIndex, undefined);
  assert.equal(props.fileIndex.type, "integer");
  assert.equal(props.limit.maximum, undefined);
  assert.match(props.limit.description, /clamp|max 100/);
  // prepareArguments runs before schema validation in Pi, so legacy calls
  // get the guiding error rather than a generic validation failure.
  assert.throws(
    () => tool.prepareArguments({ action: "open" }),
    /not available to agents/,
  );
  assert.throws(
    () => tool.prepareArguments({ action: "issues", issueIndex: 1 }),
    /not available to agents/,
  );
  const ok = { action: "duplications", fileIndex: 2 };
  assert.equal(tool.prepareArguments(ok), ok);
});

test("MCP schema does not cap limit (core clamps)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sonarqube-rf34mcp-"));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/mcp/server.js", import.meta.url))],
      cwd,
      env: { ...process.env, SONARQUBE_URL: "http://127.0.0.1:1" },
    }),
  );
  try {
    const { tools } = await client.listTools();
    const max = tools[0].inputSchema.properties.limit.maximum;
    assert.ok(max === undefined || max > 100);
  } finally {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
