import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function withFakeSonar(run) {
  const requests = [];
  const http = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    requests.push({
      path: url.pathname,
      component:
        url.searchParams.get("component") ??
        url.searchParams.get("componentKeys"),
      auth: req.headers.authorization,
    });
    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname === "/api/measures/component") {
      res.end(
        JSON.stringify({
          component: { measures: [{ metric: "coverage", value: "50" }] },
        }),
      );
    } else if (url.pathname === "/api/v2/clean-code-policy/mode") {
      res.end(JSON.stringify({ mode: "STANDARD" }));
    } else {
      res.end(JSON.stringify({ total: 0, issues: [], facets: [] }));
    }
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${http.address().port}`, requests);
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
}

async function withWorkspace(env, run) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sonarqube-init-"));
  await mkdir(join(cwd, ".git"));
  const base = { ...process.env };
  for (const k of [
    "SONARQUBE_URL",
    "SONAR_HOST_URL",
    "SONARQUBE_TOKEN",
    "SONAR_TOKEN",
    "SONAR_PROJECT_KEY",
  ])
    delete base[k];
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd,
      env: { ...base, ...env },
    }),
  );
  try {
    await run(client, cwd);
  } finally {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

const call = (client, args) =>
  client.callTool({ name: "sonarqube", arguments: args });
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

test("init writes .claude/sonarqube.json for the path and registers it", async () => {
  await withWorkspace({}, async (client, cwd) => {
    await mkdir(join(cwd, "apps", "Web App"), { recursive: true });
    const result = await call(client, {
      action: "init",
      path: "apps/Web App",
      serverUrl: "https://sonar.example.com/",
      projectKey: "web",
      token: "secret",
    });
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.deepEqual(
      await readJson(join(cwd, "apps", "Web App", ".claude", "sonarqube.json")),
      {
        serverUrl: "https://sonar.example.com",
        projectKey: "web",
        token: "secret",
      },
    );
    const registry = await readJson(
      join(cwd, ".claude", "sonarqube.workspaces.json"),
    );
    assert.equal(registry.workspaces["web-app"], "apps/Web App");
    assert.match(result.content[0].text, /SONARQUBE_TOKEN/);
  });
});

test("init defaults to localhost and the directory slug, without a token", async () => {
  await withWorkspace({}, async (client, cwd) => {
    const result = await call(client, { action: "init" });
    assert.notEqual(result.isError, true, result.content[0].text);
    const cfg = await readJson(join(cwd, ".claude", "sonarqube.json"));
    assert.equal(cfg.serverUrl, "http://localhost:9000");
    assert.match(cfg.projectKey, /^pi-sonarqube-init-/);
    assert.equal("token" in cfg, false);
  });
});

test("init reports a missing path as a tool error", async () => {
  await withWorkspace({}, async (client) => {
    const result = await call(client, { action: "init", path: "./nope" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not found/);
  });
});

test("only .pi/sonarqube.json present: the adapter uses it", async () => {
  await withFakeSonar(async (url, requests) => {
    await withWorkspace({}, async (client, cwd) => {
      await mkdir(join(cwd, ".pi"));
      await writeFile(
        join(cwd, ".pi", "sonarqube.json"),
        JSON.stringify({
          serverUrl: url,
          projectKey: "from-pi",
          token: "pi-tok",
        }),
      );
      const result = await call(client, { action: "metrics" });
      assert.notEqual(result.isError, true, result.content[0].text);
      assert.ok(requests.some((r) => r.component === "from-pi"));
    });
  });
});

test(".claude config wins over .pi config", async () => {
  await withFakeSonar(async (url, requests) => {
    await withWorkspace({}, async (client, cwd) => {
      for (const [dir, key] of [
        [".pi", "from-pi"],
        [".claude", "from-claude"],
      ]) {
        await mkdir(join(cwd, dir));
        await writeFile(
          join(cwd, dir, "sonarqube.json"),
          JSON.stringify({ serverUrl: url, projectKey: key }),
        );
      }
      await call(client, { action: "metrics" });
      assert.ok(requests.some((r) => r.component === "from-claude"));
      assert.ok(!requests.some((r) => r.component === "from-pi"));
    });
  });
});

test(".pi workspace registry aliases still resolve as targets", async () => {
  await withFakeSonar(async (url, requests) => {
    await withWorkspace({}, async (client, cwd) => {
      await mkdir(join(cwd, "svc", ".pi"), { recursive: true });
      await writeFile(
        join(cwd, "svc", ".pi", "sonarqube.json"),
        JSON.stringify({ serverUrl: url, projectKey: "svc-key" }),
      );
      await mkdir(join(cwd, ".pi"));
      await writeFile(
        join(cwd, ".pi", "sonarqube.workspaces.json"),
        JSON.stringify({ version: 1, workspaces: { svc: "svc" } }),
      );
      const result = await call(client, { action: "metrics", path: "svc" });
      assert.notEqual(result.isError, true, result.content[0].text);
      assert.ok(requests.some((r) => r.component === "svc-key"));
    });
  });
});

test("environment variables override file config", async () => {
  await withFakeSonar(async (url, requests) => {
    await withWorkspace(
      {
        SONAR_HOST_URL: url,
        SONAR_PROJECT_KEY: "env-key",
        SONAR_TOKEN: "env-tok",
      },
      async (client, cwd) => {
        await mkdir(join(cwd, ".claude"));
        await writeFile(
          join(cwd, ".claude", "sonarqube.json"),
          JSON.stringify({
            serverUrl: "http://127.0.0.1:1",
            projectKey: "file-key",
            token: "file-tok",
          }),
        );
        const result = await call(client, { action: "metrics" });
        assert.notEqual(result.isError, true, result.content[0].text);
        assert.ok(requests.some((r) => r.component === "env-key"));
        const expected = "Basic " + Buffer.from("env-tok:").toString("base64");
        assert.ok(requests.every((r) => r.auth === expected));
      },
    );
  });
});

test("/sonarqube-init command calls the init action", async () => {
  const md = await readFile(
    new URL("../commands/sonarqube-init.md", import.meta.url),
    "utf8",
  );
  assert.match(md, /allowed-tools: mcp__plugin_sonarqube_sonarqube__sonarqube/);
  assert.match(md, /"init"/);
  assert.match(md, /SONARQUBE_TOKEN/);
});
