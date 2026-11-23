import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("/sonarqube-open uses issues + file reads instead of the open action", async () => {
  const md = await read("commands/sonarqube-open.md");
  assert.match(
    md,
    /allowed-tools: .*mcp__plugin_sonarqube_sonarqube__sonarqube/,
  );
  assert.match(md, /allowed-tools: .*\bRead\b/);
  assert.match(md, /\$ARGUMENTS/);
  assert.match(md, /issue:/);
  assert.match(md, /issueKeys/);
  assert.match(md, /latest issue list/);
  assert.doesNotMatch(md, /action "open"/);
  assert.doesNotMatch(md, /issueIndex/);
});

test("README documents /sonarqube-open", async () => {
  assert.match(await read("README.md"), /\/sonarqube-open/);
});
