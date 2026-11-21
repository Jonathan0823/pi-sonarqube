import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSonarAction } from "../dist/core/actions.js";
import { DEFAULT_SONAR_EXCLUSIONS } from "../dist/core/config.js";
import { initProject } from "../dist/core/init.js";

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

async function withTmp(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-sonarqube-review-"));
  const originalFetch = globalThis.fetch;
  try {
    await run(root);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
}

async function configure(dir, configDir = ".host") {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "line 1\nline 2\n");
  await mkdir(join(dir, configDir), { recursive: true });
  await writeFile(
    join(dir, configDir, "sonarqube.json"),
    JSON.stringify({ serverUrl: "http://core.test", projectKey: "demo" }),
  );
}

const state = (dir, key) => ({
  version: 1,
  analyzedAt: "now",
  baseDir: dir,
  serverUrl: "http://core.test",
  projectKey: "demo",
  totalIssues: 1,
  issues: [
    {
      key,
      rule: "r",
      severity: "MAJOR",
      message: "m",
      filePath: "src/a.ts",
      line: 1,
    },
  ],
});

const rawIssue = (key) => ({
  key,
  rule: "r",
  severity: "MAJOR",
  message: "m",
  component: "demo:src/a.ts",
  line: 1,
  status: "OPEN",
});

function envFor(dir, extra = {}, cached) {
  return {
    cwd: dir,
    configDirName: ".host",
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    store: {
      get: () => cached,
      remember() {},
      persist() {},
    },
    ...extra,
  };
}

test("Pi-style positional open refetches with filters and falls back to cache", async () => {
  await withTmp(async (dir) => {
    await configure(dir);
    const urls = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.pathname === "/api/issues/search") {
        return jsonResponse({ total: 1, issues: [rawIssue("FRESH-1")] });
      }
      if (url.pathname === "/api/v2/clean-code-policy/mode") {
        return jsonResponse({ mode: "MQR" });
      }
      return jsonResponse({ rule: { name: "n" } });
    };
    const env = envFor(dir, {}, state(dir, "CACHED-1"));
    const result = await runSonarAction(
      { action: "open", issueIndex: 1, severities: ["MAJOR"] },
      env,
    );
    assert.match(result.text, /FRESH-1|m/);
    assert.equal(result.details.selectedIssue.key, "FRESH-1");
    assert.ok(
      urls.some(
        (u) =>
          u.pathname === "/api/issues/search" &&
          /MAJOR/.test(u.searchParams.toString()),
      ),
    );

    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    const cached = await runSonarAction({ action: "open", issueIndex: 1 }, env);
    assert.equal(cached.details.selectedIssue.key, "CACHED-1");
  });
});

test("positionalOpenFromSession opens from the store without fetching", async () => {
  await withTmp(async (dir) => {
    await configure(dir);
    let fetched = 0;
    globalThis.fetch = async () => {
      fetched++;
      throw new Error("offline");
    };
    const withList = await runSonarAction(
      { action: "open", issueIndex: 1 },
      envFor(dir, { positionalOpenFromSession: true }, state(dir, "S-1")),
    );
    assert.equal(withList.details.selectedIssue.key, "S-1");
    const none = await runSonarAction(
      { action: "open", issueIndex: 1 },
      envFor(dir, { positionalOpenFromSession: true }),
    );
    assert.equal(none.details.code, "no_analysis");
    assert.equal(fetched, 0);
  });
});

test("strictTargetPath rejects a source path only when enabled", async () => {
  await withTmp(async (root) => {
    const dir = join(root, "repo");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "sonar-project.properties"),
      "sonar.projectKey=demo\n",
    );
    await configure(dir);
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    const sub = join(dir, "src");
    await assert.rejects(
      runSonarAction(
        { action: "issues", path: sub },
        envFor(dir, { strictTargetPath: true }),
      ),
      /source path/,
    );
    await assert.rejects(
      runSonarAction({ action: "issues", path: sub }, envFor(dir)),
      (error) => !/source path/.test(error.message),
    );
  });
});

test("strictTargetPath compares path segments, not string prefixes", async () => {
  await withTmp(async (root) => {
    const repo = join(root, "repo");
    const sibling = join(root, "repo2");
    await mkdir(repo, { recursive: true });
    await mkdir(join(sibling, "sub"), { recursive: true });
    await writeFile(
      join(sibling, "sonar-project.properties"),
      "sonar.projectKey=x\n",
    );
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    await assert.rejects(
      runSonarAction(
        { action: "issues", path: join(sibling, "sub") },
        envFor(repo, { strictTargetPath: true }),
      ),
      (error) => !/source path/.test(error.message),
    );
  });
});

test("defaults exclude .claude and init advises gitignoring a stored token", async () => {
  assert.ok(DEFAULT_SONAR_EXCLUSIONS.includes(".claude/**"));
  await withTmp(async (dir) => {
    const withToken = await initProject(
      { path: dir, token: "secret" },
      { cwd: dir, configDirName: ".claude" },
    );
    assert.match(withToken, /gitignore/);
    assert.match(withToken, /\.claude\/sonarqube\.json/);
    const dir2 = join(dir, "other");
    await mkdir(dir2);
    const noToken = await initProject(
      { path: dir2 },
      { cwd: dir2, configDirName: ".claude" },
    );
    assert.doesNotMatch(noToken, /gitignore/);
  });
});

test("command hints are host-correct and soft results are marked", async () => {
  await withTmp(async (dir) => {
    const pi = await runSonarAction(
      { action: "metrics", path: "nope" },
      envFor(dir),
    );
    assert.match(pi.text, /Run \/sonarqube init first/);
    assert.equal(pi.soft, true);
    const mcp = await runSonarAction(
      { action: "metrics", path: "nope" },
      envFor(dir, { commandHint: (name) => "/sonarqube-" + name }),
    );
    assert.match(mcp.text, /Run \/sonarqube-init first/);
    await assert.rejects(
      runSonarAction(
        { action: "issues", path: "nope" },
        envFor(dir, { commandHint: (name) => "/sonarqube-" + name }),
      ),
      /\/sonarqube-init <alias> <path>/,
    );
    await configure(dir);
    globalThis.fetch = async () =>
      jsonResponse({ component: { measures: [] } });
    const ok = await runSonarAction(
      { action: "open", issueIndex: 1 },
      envFor(dir, { positionalOpenFromSession: true }, state(dir, "K")),
    );
    assert.equal(ok.soft, undefined);
  });
});
