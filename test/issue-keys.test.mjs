import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import sonarqube from "../dist/index.js";
import {
  assertIssueSelection,
  formatIssue,
  parseCommandArgs,
  sonarArgumentCompletions,
} from "../dist/commands.js";

function mockResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

const theme = {
  fg: (_kind, text) => text,
  bold: (text) => text,
};

const issue = (key, filePath = "src/a.ts") => ({
  key,
  rule: "typescript:S1",
  severity: "MAJOR",
  message: `Issue ${key}`,
  filePath,
  line: 1,
  status: "OPEN",
});

test("parses and validates stable issue key selectors", () => {
  assert.deepEqual(parseCommandArgs("open apps/web issue:key-b,key-a,key-b"), {
    action: "open",
    targetInput: "apps/web",
    issueIndex: undefined,
    issueKeys: ["key-b", "key-a"],
    filters: undefined,
  });
  assert.throws(
    () => assertIssueSelection(1, ["key-a"]),
    /either issueIndex or issueKeys/,
  );
  assert.throws(
    () => assertIssueSelection(undefined, Array(11).fill("key")),
    /At most 10/,
  );
  assert.throws(() => parseCommandArgs("open issue:"), /requires an issue key/);
});

test("issue keys remain in LLM output but stay hidden from UI autocomplete", async () => {
  assert.match(formatIssue(issue("key-a"), 1), /^01\. \[key-a\]/);

  const suggestions =
    (await sonarArgumentCompletions("open ", [issue("key-a")])) ?? [];
  assert.ok(!suggestions.some((item) => item.value === "issue:key-a"));
});

test("tool batch open queries exact keys once and preserves requested order", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-sonarqube-keys-"));
  const originalFetch = globalThis.fetch;
  let issueSearchUrl;

  try {
    await mkdir(join(projectDir, ".pi"));
    await mkdir(join(projectDir, "src"));
    await writeFile(
      join(projectDir, ".pi", "sonarqube.json"),
      JSON.stringify({
        serverUrl: "http://issue-keys.test",
        projectKey: "demo",
      }),
    );
    await writeFile(join(projectDir, "src", "a.ts"), "const a = 1;\n");
    await writeFile(join(projectDir, "src", "b.ts"), "const b = 2;\n");

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/issues/search") {
        issueSearchUrl = url;
        return mockResponse({
          total: 2,
          issues: [
            {
              key: "key-a",
              rule: "typescript:S1",
              severity: "MAJOR",
              message: "Issue key-a",
              component: "demo:src/a.ts",
              line: 1,
              status: "OPEN",
            },
            {
              key: "key-b",
              rule: "typescript:S1",
              severity: "MAJOR",
              message: "Issue key-b",
              component: "demo:src/b.ts",
              line: 1,
              status: "OPEN",
            },
          ],
        });
      }
      if (url.pathname === "/api/rules/show") {
        return mockResponse({ rule: { name: "Test rule" } });
      }
      if (url.pathname === "/api/v2/clean-code-policy/mode") {
        return mockResponse({ mode: "STANDARD" });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    let tool;
    sonarqube({
      on() {},
      registerCommand() {},
      registerTool(definition) {
        tool = definition;
      },
    });

    const result = await tool.execute(
      "call-1",
      {
        action: "open",
        path: projectDir,
        issueKeys: ["key-b", "missing", "key-a"],
      },
      undefined,
      undefined,
      { cwd: projectDir },
    );

    assert.equal(
      issueSearchUrl.searchParams.get("issues"),
      "key-b,missing,key-a",
    );
    assert.equal(issueSearchUrl.searchParams.has("resolved"), false);
    assert.deepEqual(
      result.details.selectedIssues.map((selected) => selected.key),
      ["key-b", "key-a"],
    );
    assert.deepEqual(result.details.missingIssueKeys, ["missing"]);
    assert.ok(
      result.content[0].text.indexOf("[key-b]") <
        result.content[0].text.indexOf("[key-a]"),
    );
    assert.match(result.content[0].text, /Issue key "missing" was not found/);

    const rendered = tool.renderResult(result, { expanded: false }, theme, {});
    const renderedText = rendered.render(200).join("\n");
    assert.match(renderedText, /const b = 2;/);
    assert.match(renderedText, /Requested issue was not found/);
    assert.doesNotMatch(renderedText, /\[key-b\]|key "missing"/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectDir, { recursive: true, force: true });
  }
});
