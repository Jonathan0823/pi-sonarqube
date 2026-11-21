import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("npm pack includes the MCP bin and Claude Code plugin files", () => {
  const out = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { encoding: "utf8" },
  );
  const paths = JSON.parse(out)[0].files.map((f) => f.path);
  for (const expected of [
    "dist/mcp/server.js",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".mcp.json",
    "commands/sonarqube-analyze.md",
    "commands/sonarqube-open.md",
  ]) {
    assert.ok(paths.includes(expected), `missing ${expected}`);
  }
});

test("MCP server reports the package version on initialize", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../dist/mcp/server.js", import.meta.url))],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }) + "\n",
    );
    const [line] = await once(createInterface({ input: child.stdout }), "line");
    assert.equal(JSON.parse(line).result.serverInfo.version, pkg.version);
  } finally {
    child.kill();
  }
});
