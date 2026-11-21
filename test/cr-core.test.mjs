import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSonarAction } from "../dist/core/actions.js";
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

const writeCfg = (dir, cfg) =>
  mkdir(join(dir, ".host"), { recursive: true }).then(() =>
    writeFile(join(dir, ".host", "sonarqube.json"), JSON.stringify(cfg)),
  );

test("strictTargetPath also guards metrics and duplications", async () => {
  await withTmp(async (root) => {
    const dir = join(root, "repo");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "sonar-project.properties"), "k=v\n");
    await configure(dir);
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    for (const action of ["metrics", "duplications"]) {
      await assert.rejects(
        runSonarAction(
          { action, path: join(dir, "src") },
          envFor(dir, { strictTargetPath: true }),
        ),
        /source path/,
        action,
      );
    }
  });
});

test("key-based open does not replace the session issue list", async () => {
  await withTmp(async (dir) => {
    await configure(dir);
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/issues/search") {
        return jsonResponse({ total: 1, issues: [rawIssue("B")] });
      }
      if (url.pathname === "/api/v2/clean-code-policy/mode") {
        return jsonResponse({ mode: "STANDARD" });
      }
      return jsonResponse({ rule: { name: "n" } });
    };
    let remembered = 0;
    const env = envFor(dir, {
      positionalOpenFromSession: true,
      store: {
        get: () => undefined,
        remember: () => remembered++,
        persist() {},
      },
    });
    await runSonarAction({ action: "open", issueKeys: ["B"] }, env);
    assert.equal(remembered, 0);
  });
});

test("init with only a token keeps the saved server URL and project key", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, ".git"));
    await writeCfg(dir, {
      serverUrl: "http://saved.test",
      projectKey: "saved-key",
      token: "old",
    });
    await initProject(
      { path: dir, token: "new" },
      { cwd: dir, configDirName: ".host" },
    );
    const cfg = JSON.parse(
      await readFile(join(dir, ".host", "sonarqube.json"), "utf8"),
    );
    assert.deepEqual(cfg, {
      serverUrl: "http://saved.test",
      projectKey: "saved-key",
      token: "new",
    });
    await initProject({ path: dir }, { cwd: dir, configDirName: ".host" });
    const again = JSON.parse(
      await readFile(join(dir, ".host", "sonarqube.json"), "utf8"),
    );
    assert.equal(again.token, "new");
    assert.equal(again.projectKey, "saved-key");
  });
});

test("init does not overwrite another target's alias", async () => {
  await withTmp(async (root) => {
    await mkdir(join(root, ".git"));
    const one = join(root, "apps", "one", "web");
    const two = join(root, "apps", "two", "web");
    await mkdir(one, { recursive: true });
    await mkdir(two, { recursive: true });
    const env = { cwd: root, configDirName: ".host" };
    await initProject({ path: one }, env);
    await initProject({ path: two }, env);
    await initProject({ path: one }, env);
    const reg = JSON.parse(
      await readFile(join(root, ".host", "sonarqube.workspaces.json"), "utf8"),
    );
    assert.deepEqual(reg.workspaces, {
      web: join("apps", "one", "web"),
      "web-2": join("apps", "two", "web"),
    });
  });
});

test("cached fallback requires matching filters and a connection error", async () => {
  await withTmp(async (dir) => {
    await configure(dir);
    const cached = {
      ...state(dir, "MINOR-1"),
      filters: { severities: ["MINOR"] },
    };
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const env = envFor(dir, { positionalOpenFromSession: false }, cached);
    await assert.rejects(
      runSonarAction({ action: "issues", severities: ["CRITICAL"] }, env),
      /fetch failed/,
    );
    const ok = await runSonarAction(
      { action: "issues", severities: ["MINOR"] },
      env,
    );
    assert.equal(ok.details.issues[0].key, "MINOR-1");
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      statusText: "x",
      async text() {
        return "";
      },
      async json() {
        return {};
      },
    });
    await assert.rejects(
      runSonarAction({ action: "issues", severities: ["MINOR"] }, env),
      /SonarQube API request failed/,
    );
  });
});

test("metrics passes the caller signal to the reachability probe", async () => {
  await withTmp(async (dir) => {
    await configure(dir);
    const signals = [];
    globalThis.fetch = async (_url, init) => {
      signals.push(init?.signal);
      return {
        ok: false,
        status: 404,
        statusText: "NF",
        async text() {
          return "";
        },
        async json() {
          return {};
        },
      };
    };
    const controller = new AbortController();
    const result = await runSonarAction(
      { action: "metrics" },
      envFor(dir, { signal: controller.signal }),
    );
    assert.equal(result.details.code, "not_analyzed");
    assert.equal(signals.at(-1), controller.signal);
  });
});
