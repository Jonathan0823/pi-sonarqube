import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (p) =>
  JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8"));
const pkg = await readJson("package.json");

test("marketplace lists the sonarqube plugin from the repo root", async () => {
  const mp = await readJson(".claude-plugin/marketplace.json");
  assert.equal(mp.name, "pi-sonarqube");
  assert.deepEqual(
    mp.plugins.map((p) => [p.name, p.source]),
    [["sonarqube", "./"]],
  );
});

test("plugin manifest matches the package version", async () => {
  const plugin = await readJson(".claude-plugin/plugin.json");
  assert.equal(plugin.name, "sonarqube");
  assert.equal(plugin.version, pkg.version);
});

test(".mcp.json launches the published package bin, not gitignored dist", async () => {
  const { mcpServers } = await readJson(".mcp.json");
  const server = mcpServers.sonarqube;
  assert.equal(server.command, "npx");
  const [bin] = Object.keys(pkg.bin);
  assert.deepEqual(server.args, ["-y", "-p", `${pkg.name}@latest`, bin]);
});

test("/sonarqube-metrics command calls the metrics action with the target", async () => {
  const md = await readFile(
    new URL("../commands/sonarqube-metrics.md", import.meta.url),
    "utf8",
  );
  assert.match(md, /argument-hint: \[target\]/);
  assert.match(md, /allowed-tools: mcp__plugin_sonarqube_sonarqube__sonarqube/);
  assert.match(md, /"metrics"/);
  assert.match(md, /\$ARGUMENTS/);
});

test("/sonarqube-duplications command takes a target and file number", async () => {
  const md = await readFile(
    new URL("../commands/sonarqube-duplications.md", import.meta.url),
    "utf8",
  );
  assert.match(md, /argument-hint: \[target\] \[file number\]/);
  assert.match(md, /allowed-tools: mcp__plugin_sonarqube_sonarqube__sonarqube/);
  assert.match(md, /"duplications"/);
  assert.match(md, /fileIndex/);
  assert.match(md, /\$ARGUMENTS/);
});

test("README documents Claude Code install", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  assert.match(readme, /\/plugin marketplace add Jonathan0823\/pi-sonarqube/);
  assert.match(readme, /\/plugin install sonarqube@pi-sonarqube/);
  assert.match(readme, /\/sonarqube-metrics/);
});
