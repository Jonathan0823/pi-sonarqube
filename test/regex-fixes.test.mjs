import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  slugify,
  normalizeServerUrl,
  ensureDefaultSonarProjectProperties,
} from "../dist/config.js";
import { resolvePathScope } from "../dist/api.js";
import { sonarqubeArgumentText } from "../dist/index.js";

let tempDirs = [];

after(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

async function makePropertiesDir(content) {
  const dir = await mkdtemp(join(tmpdir(), "sq-prop-"));
  tempDirs.push(dir);
  await writeFile(resolve(dir, "sonar-project.properties"), content, "utf8");
  return dir;
}

// ── slugify ─────────────────────────────────────────────────────────────────

test("slugify trims leading and trailing hyphens", () => {
  assert.equal(slugify("--Hello World--"), "hello-world");
  assert.equal(slugify("---my---project---"), "my-project");
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("--"), "sonarqube"); // trims to empty -> fallback
});

// ── normalizeServerUrl ──────────────────────────────────────────────────────

test("normalizeServerUrl trims trailing slashes", () => {
  assert.equal(
    normalizeServerUrl("http://localhost:9000///"),
    "http://localhost:9000",
  );
  assert.equal(
    normalizeServerUrl("https://sonar.example.com/"),
    "https://sonar.example.com",
  );
  assert.equal(normalizeServerUrl(undefined), "http://localhost:9000");
  assert.equal(normalizeServerUrl("   "), "http://localhost:9000");
});

// ── resolvePathScope ────────────────────────────────────────────────────────

test("resolvePathScope scopes to project path", () => {
  assert.equal(resolvePathScope("/repo", "proj", "src"), "proj:src");
  assert.equal(
    resolvePathScope("/repo", "proj", "src/api.ts"),
    "proj:src/api.ts",
  );
  assert.equal(resolvePathScope("/repo", "proj", "."), "proj");
  assert.equal(resolvePathScope("/repo", "proj", ""), "proj");
});

// ── ensureDefaultSonarProjectProperties ─────────────────────────────────────

test("ensureDefaultSonarProjectProperties fills empty sources", async () => {
  const dir = await makePropertiesDir(
    "sonar.sources=\nsonar.exclusions=dist\n",
  );
  const result = await ensureDefaultSonarProjectProperties(dir);
  assert.equal(result, "updated");

  const text = await readFile(resolve(dir, "sonar-project.properties"), "utf8");
  assert.match(text, /sonar\.sources=\./);
  assert.ok(text.includes("dist"));
  assert.ok(text.includes("node_modules"));
});

test("ensureDefaultSonarProjectProperties preserves other lines and normalizes trailing newlines", async () => {
  const dir = await makePropertiesDir(
    "sonar.projectKey=my-app\nsonar.sources=\nsonar.exclusions=\n\n\n",
  );
  const result = await ensureDefaultSonarProjectProperties(dir);
  assert.equal(result, "updated");

  const text = await readFile(resolve(dir, "sonar-project.properties"), "utf8");
  assert.ok(text.startsWith("sonar.projectKey=my-app\n"));
  assert.ok(!text.includes("\n\n"));
  assert.ok(text.endsWith("\n"));
});

// ── sonarqubeArgumentText ───────────────────────────────────────────────────

test("sonarqubeArgumentText parses autocomplete prefix", () => {
  assert.equal(sonarqubeArgumentText("/sonarqube"), "");
  assert.equal(sonarqubeArgumentText("/sonarqube "), "");
  assert.equal(sonarqubeArgumentText("/sonarqube  issues"), "issues");
  assert.equal(
    sonarqubeArgumentText("/sonarqube issues be rule:"),
    "issues be rule:",
  );
  assert.equal(sonarqubeArgumentText("/sonarqube foo "), "foo ");
  assert.equal(sonarqubeArgumentText("/sonarqubeX"), undefined);
  assert.equal(sonarqubeArgumentText("  /sonarqube issues"), undefined);
});
