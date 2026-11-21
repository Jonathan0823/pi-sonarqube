import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import sonarqube from "../dist/index.js";

const theme = {
  fg: (_kind, text) => text,
  bold: (text) => text,
};

function mockResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function duplicatedFile(key, path) {
  return {
    key,
    path,
    measures: [
      { metric: "duplicated_lines", value: "4" },
      { metric: "duplicated_lines_density", value: "20.0" },
      { metric: "duplicated_blocks", value: "1" },
    ],
  };
}

test("Pi duplications renderer shows every text block", () => {
  let tool;
  sonarqube({
    on() {},
    registerCommand() {},
    registerTool(definition) {
      tool = definition;
    },
  });

  const result = {
    content: [
      { type: "text", text: "Duplication count: 1" },
      { type: "text", text: "src/a.ts preview: const a = 1;" },
    ],
    details: { projectKey: "demo", files: [] },
  };
  const rendered = tool.renderResult(result, { expanded: true }, theme, {});
  const text = rendered.render(200).join("\n");

  assert.match(text, /Duplication count: 1/);
  assert.match(text, /src\/a\.ts preview: const a = 1;/);
});

test("Pi duplication drill-down leaves the editor alone when the file is gone", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-sonarqube-dup-ui-"));
  const originalFetch = globalThis.fetch;
  let treeCalls = 0;

  try {
    await mkdir(join(projectDir, ".pi"));
    await writeFile(
      join(projectDir, ".pi", "sonarqube.json"),
      JSON.stringify({ serverUrl: "http://dup-ui.test", projectKey: "demo" }),
    );

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/measures/component_tree") {
        treeCalls += 1;
        // The list shows two duplicated files; the re-fetch for the drill-down
        // only has one, so the selected index no longer exists.
        const components =
          treeCalls === 1
            ? [
                duplicatedFile("demo:src/a.ts", "src/a.ts"),
                duplicatedFile("demo:src/b.ts", "src/b.ts"),
              ]
            : [duplicatedFile("demo:src/a.ts", "src/a.ts")];
        return mockResponse({ components });
      }
      if (url.pathname === "/api/duplications/show") {
        return mockResponse({ duplications: [], files: {} });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const commands = new Map();
    sonarqube({
      on() {},
      registerCommand(name, command) {
        commands.set(name, command);
      },
      registerTool() {},
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
      appendEntry() {},
    });

    const editorWrites = [];
    const notices = [];
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: projectDir,
      sessionManager: { getEntries: () => [], getBranch: () => [] },
      ui: {
        setStatus() {},
        addAutocompleteProvider() {},
        custom: async () => 1,
        setEditorText(text) {
          editorWrites.push(text);
        },
        notify(message, level) {
          notices.push({ message, level });
        },
      },
    };

    await commands.get("sonarqube").handler("on", ctx);
    await commands.get("sonarqube").handler(`duplications ${projectDir}`, ctx);

    assert.equal(treeCalls, 2);
    assert.deepEqual(editorWrites, []);
    assert.equal(notices.at(-1)?.level, "warning");
    assert.match(notices.at(-1)?.message ?? "", /not found/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectDir, { recursive: true, force: true });
  }
});
