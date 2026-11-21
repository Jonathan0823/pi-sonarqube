import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(
  new URL("../dist/mcp/server.js", import.meta.url),
);

const RAW_ISSUES = [
  {
    key: "AX-1",
    rule: "typescript:S1",
    severity: "MAJOR",
    message: "Remove this unused import",
    component: "demo:src/a.ts",
    line: 3,
    status: "OPEN",
  },
  {
    key: "AX-2",
    rule: "typescript:S2",
    severity: "CRITICAL",
    message: "Refactor this function",
    component: "demo:src/b.ts",
    line: 9,
    status: "OPEN",
  },
];

async function withFakeSonar(run) {
  const http = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/v2/clean-code-policy/mode")
      return send({ mode: "MQR" });
    if (url.pathname === "/api/rules/show")
      return send({ rule: { name: "Rule name" } });
    if (url.pathname === "/api/issues/search") {
      return send({ total: RAW_ISSUES.length, issues: RAW_ISSUES });
    }
    return send({ errors: [{ msg: "not found" }] }, 404);
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${http.address().port}`);
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
}

async function withClient(serverUrl, run) {
  const root = await mkdtemp(join(tmpdir(), "pi-sonarqube-open-"));
  const cwd = join(root, "project");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(
    join(cwd, "sonar-project.properties"),
    "sonar.projectKey=demo\n",
  );
  const lines = (n) =>
    Array.from({ length: 12 }, (_, i) => `${n} line ${i + 1}`).join("\n") +
    "\n";
  await writeFile(join(cwd, "src/a.ts"), lines("alpha"));
  await writeFile(join(cwd, "src/b.ts"), lines("beta"));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd,
      env: {
        ...process.env,
        SONARQUBE_URL: serverUrl,
        SONARQUBE_TOKEN: "tok",
        SONAR_PROJECT_KEY: "",
      },
    }),
  );
  try {
    await run(client);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}

const call = async (client, args) => {
  const result = await client.callTool({ name: "sonarqube", arguments: args });
  return {
    isError: result.isError,
    text: result.content.map((c) => c.text).join("\n"),
  };
};

test("open by several issue keys returns a snippet for each", async () => {
  await withFakeSonar((url) =>
    withClient(url, async (client) => {
      const result = await call(client, {
        action: "open",
        issueKeys: ["AX-1", "AX-2"],
      });
      assert.notEqual(result.isError, true, result.text);
      assert.match(result.text, /alpha line 3/);
      assert.match(result.text, /beta line 9/);
    }),
  );
});

test("open by one issue key returns its snippet", async () => {
  await withFakeSonar((url) =>
    withClient(url, async (client) => {
      const result = await call(client, {
        action: "open",
        issueKeys: ["AX-2"],
      });
      assert.notEqual(result.isError, true, result.text);
      assert.match(result.text, /beta line 9/);
      assert.doesNotMatch(result.text, /alpha line 3/);
    }),
  );
});

test("positional open uses the latest list from a previous call", async () => {
  await withFakeSonar((url) =>
    withClient(url, async (client) => {
      const list = await call(client, { action: "issues" });
      assert.notEqual(list.isError, true, list.text);
      const result = await call(client, { action: "open", issueIndex: 2 });
      assert.notEqual(result.isError, true, result.text);
      assert.match(result.text, /beta line 9/);
      const first = await call(client, { action: "open", issueIndex: 1 });
      assert.match(first.text, /alpha line 3/);
    }),
  );
});

test("positional open with no prior list says no analysis yet", async () => {
  await withFakeSonar((url) =>
    withClient(url, async (client) => {
      const result = await call(client, { action: "open", issueIndex: 1 });
      assert.equal(result.isError, true);
      assert.match(result.text, /No SonarQube analysis has been run/);
    }),
  );
});

test("open rejects blank-only issueKeys with the selector error", async () => {
  await withClient("http://127.0.0.1:1", async (client) => {
    const blank = await call(client, { action: "open", issueKeys: [" "] });
    assert.equal(blank.isError, true);
    assert.match(blank.text, /issueIndex or issueKeys/);
  });
});

test("open with both or neither of issueIndex and issueKeys is a clear error", async () => {
  await withFakeSonar((url) =>
    withClient(url, async (client) => {
      const both = await call(client, {
        action: "open",
        issueIndex: 1,
        issueKeys: ["AX-1"],
      });
      assert.equal(both.isError, true);
      assert.match(both.text, /either issueIndex or issueKeys/);
      const neither = await call(client, { action: "open" });
      assert.equal(neither.isError, true);
      assert.match(neither.text, /issueIndex or issueKeys/);
    }),
  );
});
