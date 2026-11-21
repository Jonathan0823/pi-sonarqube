import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

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

/** A fake SonarQube that records every request it serves. */
async function withFakeSonar(run, { ceStatuses = ["SUCCESS"] } = {}) {
  const requests = [];
  let ceCalls = 0;
  const http = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    requests.push(url);
    if (url.pathname === "/api/ce/task") {
      const status = ceStatuses[Math.min(ceCalls++, ceStatuses.length - 1)];
      return json(res, 200, { task: { status, analysisId: "an-1" } });
    }
    if (url.pathname === "/api/v2/clean-code-policy/mode") {
      return json(res, 200, { mode: "MQR" });
    }
    if (url.pathname === "/api/rules/show") {
      return json(res, 200, { rule: { name: "Rule name" } });
    }
    if (url.pathname === "/api/measures/component") {
      return json(res, 200, {
        component: {
          measures: [
            { metric: "duplicated_lines_density", value: "3.2" },
            { metric: "duplicated_lines", value: "40" },
            { metric: "duplicated_blocks", value: "2" },
            { metric: "duplicated_files", value: "1" },
          ],
        },
      });
    }
    if (url.pathname === "/api/issues/search") {
      return json(res, 200, {
        total: RAW_ISSUES.length,
        issues: RAW_ISSUES,
      });
    }
    return json(res, 404, { errors: [{ msg: "not found" }] });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${http.address().port}`;
  try {
    await run(url, requests);
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
}

const FAKE_SCANNER = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    -Dsonar.projectBaseDir=*) base="${"$"}{arg#-Dsonar.projectBaseDir=}" ;;
    -Dsonar.projectKey=*) key="${"$"}{arg#-Dsonar.projectKey=}" ;;
  esac
done
echo "$key" >> "$FAKE_SCANNER_LOG"
if [ -n "$FAKE_SCANNER_ERROR" ]; then
  echo "$FAKE_SCANNER_ERROR" >&2
  exit 3
fi
mkdir -p "$base/.scannerwork"
cat > "$base/.scannerwork/report-task.txt" <<EOF
projectKey=$key
dashboardUrl=$FAKE_SONAR_URL/dashboard?id=$key
ceTaskUrl=$FAKE_SONAR_URL/api/ce/task?id=task-1
EOF
`;

/**
 * Runs `run(client, {cwd, scannerLog})` against the built MCP server in a temp
 * project. A fake sonar-scanner is first on PATH unless `scanner` is false.
 */
async function withClient(serverUrl, run, { scanner = true, env = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-sonarqube-analyze-"));
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  await mkdir(cwd, { recursive: true });
  await mkdir(bin);
  if (scanner) {
    await writeFile(join(bin, "sonar-scanner"), FAKE_SCANNER);
    await chmod(join(bin, "sonar-scanner"), 0o755);
  }
  const scannerLog = join(root, "scanner.log");
  await writeFile(scannerLog, "");
  await writeFile(
    join(cwd, "sonar-project.properties"),
    "sonar.projectKey=demo\n",
  );
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SONARQUBE_URL: serverUrl,
        SONARQUBE_TOKEN: "tok",
        SONAR_PROJECT_KEY: "",
        FAKE_SONAR_URL: serverUrl,
        FAKE_SCANNER_LOG: scannerLog,
        ...env,
      },
    }),
  );
  try {
    await run(client, { cwd, scannerLog });
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}

const call = (client, args) =>
  client.callTool({ name: "sonarqube", arguments: args });

test("analyze waits for the CE task, then reports issues and duplication", async () => {
  await withFakeSonar(
    (url, requests) =>
      withClient(url, async (client, { scannerLog }) => {
        const result = await call(client, { action: "analyze" });
        assert.notEqual(result.isError, true, result.content[0].text);
        const text = result.content.map((c) => c.text).join("\n");
        assert.match(text, /Remove this unused import/);
        assert.match(text, /Refactor this function/);
        assert.match(text, /3\.2%/);
        assert.match(text, /Duplication: 3\.2%\s+lines=40\s+blocks=2/);
        const paths = requests.map((u) => u.pathname);
        assert.ok(paths.filter((p) => p === "/api/ce/task").length >= 2);
        assert.ok(
          paths.lastIndexOf("/api/ce/task") <
            paths.indexOf("/api/issues/search"),
          "issues are fetched after the CE task finishes",
        );
      }),
    { ceStatuses: ["IN_PROGRESS", "SUCCESS"] },
  );
});

test("analyze gives the install hint when sonar-scanner is missing", async () => {
  await withFakeSonar((url) =>
    withClient(
      url,
      async (client) => {
        const result = await call(client, { action: "analyze" });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /SonarScanner is not installed/);
      },
      { scanner: false, env: { PATH: "/nonexistent" } },
    ),
  );
});

test("analyze surfaces the scanner's relevant error", async () => {
  await withFakeSonar((url) =>
    withClient(
      url,
      async (client) => {
        const result = await call(client, { action: "analyze" });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /scan failed/);
        assert.match(result.content[0].text, /Quality gate plugin exploded/);
      },
      { env: { FAKE_SCANNER_ERROR: "ERROR: Quality gate plugin exploded" } },
    ),
  );
});

test("issues supports legacy filters", async () => {
  await withFakeSonar((url, requests) =>
    withClient(url, async (client) => {
      const result = await call(client, {
        action: "issues",
        severities: ["critical"],
        types: ["bug"],
        statuses: ["open"],
        rules: ["typescript:S2"],
      });
      assert.notEqual(result.isError, true, result.content[0].text);
      assert.match(
        result.content.map((c) => c.text).join("\n"),
        /AX-2|Refactor/,
      );
      const search = requests.find((u) => u.pathname === "/api/issues/search");
      assert.equal(search.searchParams.get("severities"), "CRITICAL");
      assert.equal(search.searchParams.get("types"), "BUG");
      assert.equal(search.searchParams.get("statuses"), "OPEN");
      assert.equal(search.searchParams.get("rules"), "typescript:S2");
    }),
  );
});

test("issues supports MQR filters", async () => {
  await withFakeSonar((url, requests) =>
    withClient(url, async (client) => {
      const result = await call(client, {
        action: "issues",
        softwareQualities: ["maintainability"],
        impactSeverities: ["high"],
      });
      assert.notEqual(result.isError, true, result.content[0].text);
      const search = requests.find((u) => u.pathname === "/api/issues/search");
      assert.equal(
        search.searchParams.get("impactSoftwareQualities"),
        "MAINTAINABILITY",
      );
      assert.equal(search.searchParams.get("impactSeverities"), "HIGH");
    }),
  );
});

test("issues rejects mixing legacy and MQR filters", async () => {
  await withFakeSonar((url, requests) =>
    withClient(url, async (client) => {
      const result = await call(client, {
        action: "issues",
        severities: ["CRITICAL"],
        impactSeverities: ["HIGH"],
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Ambiguous filter combination/);
      assert.equal(requests.length, 0);
    }),
  );
});

test("clean-code mode is detected once and cached", async () => {
  await withFakeSonar((url, requests) =>
    withClient(url, async (client) => {
      await call(client, { action: "issues" });
      await call(client, { action: "issues", severities: ["MAJOR"] });
      await call(client, { action: "analyze" });
      const modeRequests = requests.filter(
        (u) => u.pathname === "/api/v2/clean-code-policy/mode",
      );
      assert.equal(modeRequests.length, 1);
    }),
  );
});

test("path selects a project root and pathScope scopes inside it", async () => {
  await withFakeSonar((url, requests) =>
    withClient(url, async (client, { cwd }) => {
      await mkdir(join(cwd, "apps/web/src"), { recursive: true });
      await writeFile(
        join(cwd, "apps/web/sonar-project.properties"),
        "sonar.projectKey=web\n",
      );
      const result = await call(client, {
        action: "issues",
        path: "apps/web",
        pathScope: "src/",
      });
      assert.notEqual(result.isError, true, result.content[0].text);
      const search = requests.find((u) => u.pathname === "/api/issues/search");
      assert.equal(search.searchParams.get("projects"), "web");
      assert.equal(search.searchParams.get("componentKeys"), "web:src");
    }),
  );
});

test("analyze with path scans that target's project", async () => {
  await withFakeSonar((url) =>
    withClient(url, async (client, { cwd, scannerLog }) => {
      await mkdir(join(cwd, "apps/web"), { recursive: true });
      await writeFile(
        join(cwd, "apps/web/sonar-project.properties"),
        "sonar.projectKey=web\n",
      );
      const result = await call(client, {
        action: "analyze",
        path: "apps/web",
      });
      assert.notEqual(result.isError, true, result.content[0].text);
      const { readFile } = await import("node:fs/promises");
      assert.equal((await readFile(scannerLog, "utf8")).trim(), "web");
    }),
  );
});

test("a source file or subdirectory passed as path is a clear error", async () => {
  await withFakeSonar((url, requests) =>
    withClient(url, async (client, { cwd }) => {
      await mkdir(join(cwd, "src/components"), { recursive: true });
      await writeFile(join(cwd, "src/a.ts"), "export {};\n");
      for (const path of ["src/a.ts", "src/components"]) {
        const result = await call(client, { action: "issues", path });
        assert.equal(result.isError, true, path);
        assert.match(result.content[0].text, /pathScope/, path);
      }
      assert.equal(requests.length, 0);
    }),
  );
});
