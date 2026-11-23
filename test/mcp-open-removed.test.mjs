import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(
  new URL("../dist/mcp/server.js", import.meta.url),
);

async function withClient(run) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sonarqube-noopen-"));
  await writeFile(
    join(cwd, "sonar-project.properties"),
    "sonar.projectKey=demo\n",
  );
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd,
      env: {
        ...process.env,
        SONARQUBE_URL: "http://127.0.0.1:1",
        SONARQUBE_TOKEN: "t",
        SONAR_PROJECT_KEY: "",
      },
    }),
  );
  try {
    await run(client);
  } finally {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

const call = async (client, args) => {
  try {
    const r = await client.callTool({ name: "sonarqube", arguments: args });
    return r.content.map((c) => c.text).join("\n");
  } catch (e) {
    return String(e.message);
  }
};

test("schema has no open action and no issueIndex, keeps issueKeys", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const props = tools[0].inputSchema.properties;
    assert.ok(!props.action.enum.includes("open"));
    assert.equal(props.issueIndex, undefined);
    assert.match(props.issueKeys.description, /issues/);
    assert.doesNotMatch(tools[0].description, /issueIndex|open an issue/);
  });
});

test("action open and issueIndex get the guiding error", async () => {
  await withClient(async (client) => {
    for (const args of [
      { action: "open", issueKeys: ["A"] },
      { action: "issues", issueIndex: 1 },
    ]) {
      const text = await call(client, args);
      assert.match(text, /issueKeys/);
      assert.match(text, /read the file/);
    }
  });
});
