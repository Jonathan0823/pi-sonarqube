import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

import { fetchFileDuplications } from "../dist/core/api.js";
import { discoverSonarQubeTargets } from "../dist/core/config.js";

let hasFd;
try {
  execFileSync("fd", ["--version"], { encoding: "utf8", timeout: 1000 });
  hasFd = true;
} catch {
  hasFd = false;
}

function componentsFor(paths) {
  return paths.map((path, i) => ({
    key: `demo:${i}`,
    path,
    measures: [
      { metric: "duplicated_blocks", value: "1" },
      { metric: "duplicated_lines", value: "10" },
      { metric: "duplicated_lines_density", value: "2.5" },
    ],
  }));
}

async function withTree(paths, fn) {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ components: componentsFor(paths) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const TREE = [
  "src/api/x.ts",
  "src/api-old/file.ts",
  "src/a.ts",
  "src/a.ts.bak",
];

test("pathScope matches whole path segments, not string prefixes", async () => {
  const files = await withTree(TREE, () =>
    fetchFileDuplications(
      "http://example.test",
      undefined,
      "demo",
      undefined,
      "src/api",
      "/repo",
    ),
  );
  assert.deepEqual(
    files.map((f) => f.filePath),
    ["src/api/x.ts"],
  );
});

test("pathScope naming a file matches only that exact file", async () => {
  const files = await withTree(TREE, () =>
    fetchFileDuplications(
      "http://example.test",
      undefined,
      "demo",
      undefined,
      "src/a.ts",
      "/repo",
    ),
  );
  assert.deepEqual(
    files.map((f) => f.filePath),
    ["src/a.ts"],
  );
});

test("pathScope pointing at the project root keeps every file", async () => {
  const files = await withTree(TREE, () =>
    fetchFileDuplications(
      "http://example.test",
      undefined,
      "demo",
      undefined,
      ".",
      "/repo",
    ),
  );
  assert.equal(files.length, TREE.length);
});

async function makeRepo(configs) {
  const root = await mkdtemp(join(tmpdir(), "sq-cr-"));
  await mkdir(resolve(root, ".git"), { recursive: true });
  for (const [sub, dirName] of configs) {
    const dir = resolve(root, sub, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(
      resolve(dir, "sonarqube.json"),
      JSON.stringify({ serverUrl: "http://localhost:9000", projectKey: sub }) +
        "\n",
    );
  }
  return root;
}

test(
  "fd discovery only returns configs in the selected config directory",
  { skip: !hasFd },
  async () => {
    const root = await makeRepo([
      ["apps/web", ".pi"],
      ["apps/claude-only", ".claude"],
    ]);
    try {
      const targets = await discoverSonarQubeTargets(root, ".pi", "fd");
      assert.deepEqual(
        targets.map((t) => t.dir),
        [resolve(root, "apps/web")],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
