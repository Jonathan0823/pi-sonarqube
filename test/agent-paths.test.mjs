import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

async function setup(run) {
  const outer = await mkdtemp(join(tmpdir(), "pi-sonarqube-paths-"));
  const original = globalThis.fetch;
  try {
    const cwd = join(outer, "repo");
    const web = join(cwd, "apps", "web");
    await mkdir(join(web, "src"), { recursive: true });
    await mkdir(join(web, ".host"), { recursive: true });
    await writeFile(join(web, "src", "a.ts"), "one\ntwo\nthree\n");
    await writeFile(
      join(web, "sonar-project.properties"),
      "sonar.projectKey=demo\n",
    );
    await writeFile(
      join(web, ".host", "sonarqube.json"),
      JSON.stringify({ serverUrl: "http://core.test", projectKey: "demo" }),
    );
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/issues/search") {
        return json({
          total: 1,
          issues: [
            {
              key: "K1",
              rule: "r",
              severity: "MAJOR",
              message: "m",
              component: "demo:src/a.ts",
              line: 2,
              status: "OPEN",
            },
          ],
        });
      }
      if (url.pathname === "/api/v2/clean-code-policy/mode") {
        return json({ mode: "MQR" });
      }
      if (url.pathname === "/api/measures/component_tree") {
        return json({
          components: [
            {
              key: "demo:src/a.ts",
              path: "src/a.ts",
              measures: [
                { metric: "duplicated_blocks", value: "1" },
                { metric: "duplicated_lines", value: "2" },
                { metric: "duplicated_lines_density", value: "50" },
              ],
            },
          ],
        });
      }
      if (url.pathname === "/api/duplications/show") {
        return json({
          duplications: [{ blocks: [{ from: 1, size: 2, _ref: "1" }] }],
          files: { 1: { key: "demo:src/a.ts" } },
        });
      }
      return json({ rule: { name: "n" } });
    };
    const env = (dir) => ({
      cwd: dir,
      configDirName: ".host",
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      store: { get: () => undefined, remember() {}, persist() {} },
    });
    await run({ cwd, web, env });
  } finally {
    globalThis.fetch = original;
    await rm(outer, { recursive: true, force: true });
  }
}

test("issues text is relative to cwd; details stay project-relative", async () => {
  await setup(async ({ cwd, env }) => {
    const r = await runSonarAction(
      { action: "issues", path: "apps/web" },
      env(cwd),
    );
    assert.match(r.text, /apps\/web\/src\/a\.ts\n\s+K1 MAJOR :2/);
    assert.equal(r.details.issues[0].filePath, "src/a.ts");
  });
});

test("issues text is unchanged when project root equals cwd", async () => {
  await setup(async ({ web, env }) => {
    const r = await runSonarAction({ action: "issues" }, env(web));
    assert.match(r.text, /src\/a\.ts\n\s+K1 MAJOR :2/);
  });
});

test("issues text uses absolute paths when base dir is outside cwd", async () => {
  await setup(async ({ cwd, web, env }) => {
    const other = join(cwd, "elsewhere");
    await mkdir(other, { recursive: true });
    const r = await runSonarAction({ action: "issues", path: web }, env(other));
    assert.match(
      r.text,
      new RegExp(join(web, "src", "a.ts").replace(/[.\\]/g, "\\$&")),
    );
  });
});

test("duplication list and previews use cwd-relative paths", async () => {
  await setup(async ({ cwd, env }) => {
    const list = await runSonarAction(
      { action: "duplications", view: "list", path: "apps/web" },
      env(cwd),
    );
    assert.match(list.text, /apps\/web\/src\/a\.ts/);
    assert.equal(list.details.files[0].filePath, "src/a.ts");
    for (const request of [
      { action: "duplications", path: "apps/web" },
      { action: "duplications", path: "apps/web", fileIndex: 1 },
    ]) {
      const r = await runSonarAction(request, env(cwd));
      assert.match(r.text, /apps\/web\/src\/a\.ts:1-2/);
      assert.doesNotMatch(r.text, /(^|[^/])src\/a\.ts:1-2/m);
    }
  });
});
