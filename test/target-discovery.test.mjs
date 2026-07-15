import assert from "node:assert/strict";
import { test, after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverSonarQubeTargets,
  gatherTargets,
  saveWorkspaceRegistry,
} from "../dist/config.js";

// ── Strategy helpers ─────────────────────────────────────────────────────────

let hasFd;
try {
  execFileSync("fd", ["--version"], {
    encoding: "utf8",
    timeout: 1000,
  });
  hasFd = true;
} catch {
  hasFd = false;
}

function testBoth(label, fn) {
  if (hasFd) {
    test(`${label} (fd path)`, () => fn("fd"));
  }
  test(`${label} (stdlib walk)`, () => fn("walk"));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

let tempDirs = [];

async function makeRepo(layout) {
  const root = await mkdtemp(join(tmpdir(), "sq-test-"));
  tempDirs.push(root);
  await mkdir(resolve(root, ".git"), { recursive: true });
  for (const sub of layout) {
    const dir = resolve(root, sub);
    await mkdir(dir, { recursive: true });
    await mkdir(resolve(dir, ".pi"), { recursive: true });
    await writeFile(
      resolve(dir, ".pi", "sonarqube.json"),
      JSON.stringify({
        serverUrl: "http://localhost:9000",
        projectKey: sub.replace(/\//g, "-"),
      }) + "\n",
    );
  }
  return root;
}

after(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

// ── discoverSonarQubeTargets ─────────────────────────────────────────────────

testBoth("discovers single sonarqube config", async (strategy) => {
  const root = await makeRepo(["apps/web"]);
  const targets = await discoverSonarQubeTargets(root, strategy);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].dir, resolve(root, "apps/web"));
});

testBoth("discovers multiple sonarqube configs", async (strategy) => {
  const root = await makeRepo(["apps/web", "apps/api", "libs/shared"]);
  const targets = await discoverSonarQubeTargets(root, strategy);
  assert.equal(targets.length, 3);

  const dirs = targets.map((t) => t.dir).sort();
  assert.deepEqual(dirs, [
    resolve(root, "apps/api"),
    resolve(root, "apps/web"),
    resolve(root, "libs/shared"),
  ]);
});

testBoth("returns empty when no sonarqube configs exist", async (strategy) => {
  const root = await makeRepo([]); // repo root with .git but no configs
  const targets = await discoverSonarQubeTargets(root, strategy);
  assert.equal(targets.length, 0);
});

testBoth("filters out repo root when config is at root", async (strategy) => {
  const root = await makeRepo([]);
  // Create config at root level
  await mkdir(resolve(root, ".pi"), { recursive: true });
  await writeFile(
    resolve(root, ".pi", "sonarqube.json"),
    JSON.stringify({ serverUrl: "http://localhost:9000", projectKey: "root" }) +
      "\n",
  );
  const targets = await discoverSonarQubeTargets(root, strategy);
  assert.equal(targets.length, 0); // skipped because it's the repo root
});

testBoth("skips node_modules and .git", async (strategy) => {
  const root = await makeRepo(["apps/web"]);
  // Add a config deep inside node_modules that should be skipped
  const deep = resolve(root, "node_modules/some-pkg");
  await mkdir(resolve(deep, ".pi"), { recursive: true });
  await writeFile(
    resolve(deep, ".pi", "sonarqube.json"),
    JSON.stringify({ serverUrl: "http://localhost:9000", projectKey: "bad" }) +
      "\n",
  );
  // Also in .git
  await mkdir(resolve(root, ".git", "hooks", ".pi"), { recursive: true });
  await writeFile(
    resolve(root, ".git", "hooks", ".pi", "sonarqube.json"),
    JSON.stringify({ serverUrl: "http://localhost:9000", projectKey: "bad" }) +
      "\n",
  );
  const targets = await discoverSonarQubeTargets(root, strategy);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].dir, resolve(root, "apps/web"));
});

// ── gatherTargets ───────────────────────────────────────────────────────────

test("gatherTargets merges registry and discovered targets", async () => {
  const root = await makeRepo(["apps/web", "apps/api"]);
  // Register an alias for web
  await saveWorkspaceRegistry(root, "web", resolve(root, "apps/web"));

  const { repoRoot, targets } = await gatherTargets(root);
  assert.equal(repoRoot, root);

  // Should have both: web (from registry, alias preserved) and api (from discovery)
  assert.equal(targets.length, 2);

  const web = targets.find((t) => t.alias === "web");
  assert.ok(web);
  assert.equal(web.path, "apps/web");

  const api = targets.find((t) => t.alias === "api");
  assert.ok(api);
  assert.equal(api.path, "apps/api");
});

test("gatherTargets deduplicates by path", async () => {
  const root = await makeRepo(["myapp"]);
  // Register an alias that points to the same dir
  await saveWorkspaceRegistry(root, "myapp", resolve(root, "myapp"));

  const { targets } = await gatherTargets(root);
  assert.equal(targets.length, 1); // no duplicate
  assert.equal(targets[0].alias, "myapp"); // registry wins
});
