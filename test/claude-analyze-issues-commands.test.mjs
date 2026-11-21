import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

for (const action of ["analyze", "issues"]) {
  test(`/sonarqube-${action} passes target, in: and filter tokens to the tool`, async () => {
    const md = await read(`commands/sonarqube-${action}.md`);
    assert.match(md, /argument-hint: .*in:/);
    assert.match(
      md,
      /allowed-tools: mcp__plugin_sonarqube_sonarqube__sonarqube/,
    );
    assert.match(md, new RegExp(`action "${action}"`));
    assert.match(md, /\$ARGUMENTS/);
    for (const token of [
      "in:",
      "type:",
      "severity:",
      "status:",
      "rule:",
      "quality:",
      "impactSeverity:",
    ]) {
      assert.ok(md.includes(token), token);
    }
    assert.match(md, /pathScope/);
  });
}

for (const action of ["analyze", "issues"]) {
  test(`/sonarqube-${action} restricts only type: and severity: to the legacy family`, async () => {
    const md = await read(`commands/sonarqube-${action}.md`);
    assert.doesNotMatch(md, /Never mix legacy and MQR/);
    assert.match(
      md,
      /`type:`, `severity:`[^\n]*cannot be combined with `quality:` or `impactSeverity:`/,
    );
    assert.match(md, /`status:`, `rule:`[^\n]*combine with either family/);
  });
}

test("README documents the analyze and issues commands", async () => {
  const readme = await read("README.md");
  assert.match(readme, /\/sonarqube-analyze/);
  assert.match(readme, /\/sonarqube-issues/);
});
