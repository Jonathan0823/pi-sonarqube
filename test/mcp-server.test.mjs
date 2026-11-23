import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(
  new URL("../dist/mcp/server.js", import.meta.url),
);

async function withFakeSonar(handler, run) {
  const http = createServer(handler);
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${http.address().port}`);
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
}

async function withClient(serverUrl, run, files = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sonarqube-mcp-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, name)), { recursive: true });
    await writeFile(join(cwd, name), content);
  }
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd,
      env: {
        ...process.env,
        SONARQUBE_URL: serverUrl,
        SONAR_PROJECT_KEY: "demo",
        SONARQUBE_TOKEN: "tok",
      },
    }),
  );
  try {
    await run(client);
  } finally {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

function sonar(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/v2/clean-code-policy/mode") {
    return json(res, 200, { mode: "STANDARD" });
  }
  if (url.pathname === "/api/measures/component") {
    return json(res, 200, {
      component: {
        measures: [
          { metric: "coverage", value: "81.5" },
          { metric: "lines_to_cover", value: "200" },
          { metric: "uncovered_lines", value: "37" },
          { metric: "duplicated_lines_density", value: "3.2" },
          { metric: "duplicated_lines", value: "40" },
          { metric: "duplicated_blocks", value: "2" },
          { metric: "duplicated_files", value: "1" },
        ],
      },
    });
  }
  const facet = url.searchParams.get("facets");
  return json(res, 200, {
    total: 0,
    issues: [],
    facets: [
      {
        property: facet,
        values:
          facet === "severities"
            ? [
                { val: "CRITICAL", count: 4 },
                { val: "MAJOR", count: 7 },
              ]
            : [{ val: "SECURITY", count: 2 }],
      },
    ],
  });
}

test("tool schema carries pathScope and issueKeys guidance", async () => {
  await withClient("http://127.0.0.1:1", async (client) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    const tool = tools[0];
    assert.equal(tool.name, "sonarqube");
    assert.match(tool.description, /pathScope/);
    assert.match(tool.description, /issueKeys/);
    assert.match(tool.description, /severity, status, type, rule/);
    assert.deepEqual(tool.inputSchema.properties.action.enum, [
      "analyze",
      "issues",
      "metrics",
      "duplications",
      "init",
    ]);
  });
});

test("metrics returns coverage, duplication and severity breakdown", async () => {
  await withFakeSonar(sonar, (url) =>
    withClient(url, async (client) => {
      const result = await client.callTool({
        name: "sonarqube",
        arguments: { action: "metrics" },
      });
      assert.notEqual(result.isError, true);
      const text = result.content[0].text;
      assert.match(text, /Coverage: 81\.5%/);
      assert.match(text, /Duplication: 3\.2%/);
      assert.match(text, /CRITICAL 4/);
      assert.match(text, /MAJOR 7/);
    }),
  );
});

test("metrics reports an unreachable server as a tool error", async () => {
  await withFakeSonar(sonar, async (url) => {
    // Port is closed once the fake server stops, so use a dead address.
    void url;
    await withClient("http://127.0.0.1:1", async (client) => {
      const result = await client.callTool({
        name: "sonarqube",
        arguments: { action: "metrics" },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Cannot reach SonarQube/);
    });
  });
});

test("metrics reports an auth failure as a tool error", async () => {
  await withFakeSonar(
    (req, res) => json(res, 401, { errors: [{ msg: "Unauthorized" }] }),
    (url) =>
      withClient(url, async (client) => {
        const result = await client.callTool({
          name: "sonarqube",
          arguments: { action: "metrics" },
        });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /authentication failed/);
      }),
  );
});

function duplicationSonar(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/measures/component_tree") {
    return json(res, 200, {
      components: [
        {
          key: "demo:src/a.js",
          path: "src/a.js",
          measures: [
            { metric: "duplicated_lines", value: "4" },
            { metric: "duplicated_lines_density", value: "20.0" },
            { metric: "duplicated_blocks", value: "1" },
          ],
        },
        {
          key: "demo:src/b.js",
          path: "src/b.js",
          measures: [
            { metric: "duplicated_lines", value: "2" },
            { metric: "duplicated_lines_density", value: "5.5" },
            { metric: "duplicated_blocks", value: "1" },
          ],
        },
        { key: "demo:src/c.js", path: "src/c.js", measures: [] },
      ],
    });
  }
  if (url.pathname === "/api/duplications/show") {
    return json(res, 200, {
      duplications: [
        {
          blocks: [
            { from: 1, size: 3, _ref: "1" },
            { from: 10, size: 3, _ref: "2" },
          ],
        },
      ],
      files: { 1: { key: "demo:src/a.js" }, 2: { key: "demo:src/b.js" } },
    });
  }
  return sonar(req, res);
}

const sources = {
  "src/a.js": "one\ntwo\nthree\n",
  "src/b.js": Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n"),
};

test("duplications view=list returns duplicated files with stats", async () => {
  await withFakeSonar(duplicationSonar, (url) =>
    withClient(url, async (client) => {
      const result = await client.callTool({
        name: "sonarqube",
        arguments: { action: "duplications", view: "list" },
      });
      assert.notEqual(result.isError, true);
      const text = result.content[0].text;
      assert.match(text, /Duplicated files \(2\)/);
      assert.match(text, /src\/a\.js  dup%=20\.0  blocks=1  lines=4/);
      assert.match(text, /src\/b\.js  dup%=5\.5/);
      assert.doesNotMatch(text, /c\.js/);
    }),
  );
});

test("duplications fileIndex drills into block locations and line ranges", async () => {
  await withFakeSonar(duplicationSonar, (url) =>
    withClient(
      url,
      async (client) => {
        const result = await client.callTool({
          name: "sonarqube",
          arguments: { action: "duplications", fileIndex: 1 },
        });
        assert.notEqual(result.isError, true);
        const text = result.content[0].text;
        assert.match(text, /Duplications in src\/a\.js/);
        assert.match(text, /src\/a\.js:1-3/);
        assert.match(text, /src\/b\.js:10-12/);
        assert.match(text, /two/);
        assert.doesNotMatch(text, /line11/);
      },
      sources,
    ),
  );
});

test("duplications reports an unknown file number", async () => {
  await withFakeSonar(duplicationSonar, (url) =>
    withClient(url, async (client) => {
      const result = await client.callTool({
        name: "sonarqube",
        arguments: { action: "duplications", fileIndex: 9 },
      });
      assert.match(result.content[0].text, /File #9 not found/);
    }),
  );
});
