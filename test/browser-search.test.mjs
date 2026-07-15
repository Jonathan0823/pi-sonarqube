import assert from "node:assert/strict";
import { test } from "node:test";

import { DuplicationBrowser, IssueBrowser, WorkspaceBrowser } from "../dist/ui.js";

const theme = {
  fg: (_kind, text) => text,
  bold: (text) => text,
};

function renderText(component) {
  return component.render(120).join("\n");
}

test("issue browser search filters by file, rule, and message", () => {
  const browser = new IssueBrowser(
    {
      projectKey: "demo",
      totalIssues: 2,
      filters: undefined,
      issues: [
        {
          key: "1",
          filePath: "src/alpha.ts",
          line: 1,
          rule: "typescript:S100",
          severity: "MAJOR",
          message: "Alpha issue",
        },
        {
          key: "2",
          filePath: "src/beta.ts",
          line: 2,
          rule: "typescript:S101",
          severity: "CRITICAL",
          message: "Beta issue",
        },
      ],
    },
    theme,
    () => {},
  );

  browser.handleInput("b");
  browser.handleInput("e");
  browser.handleInput("t");
  browser.handleInput("a");

  const text = renderText(browser);
  assert.match(text, /Search issues by file, rule, severity, status, or message/);
  assert.match(text, /src\/beta\.ts/);
  assert.doesNotMatch(text, /src\/alpha\.ts/);
});

test("duplication browser search filters by file path and stats", () => {
  const browser = new DuplicationBrowser(
    [
      {
        filePath: "src/alpha.ts",
        fileKey: "alpha",
        duplicatedLinesDensity: 2.5,
        duplicatedBlocks: 1,
        duplicatedLines: 10,
      },
      {
        filePath: "src/beta.ts",
        fileKey: "beta",
        duplicatedLinesDensity: 8.0,
        duplicatedBlocks: 2,
        duplicatedLines: 20,
      },
    ],
    theme,
    () => {},
  );

  browser.handleInput("8");
  browser.handleInput(".");
  browser.handleInput("0");

  const text = renderText(browser);
  assert.match(text, /Search duplications by file path, duplicated lines, blocks, or density/);
  assert.match(text, /src\/beta\.ts/);
  assert.doesNotMatch(text, /src\/alpha\.ts/);
});

test("workspace browser search filters by alias and path", () => {
  const browser = new WorkspaceBrowser(
    [
      { alias: "web", path: "apps/web" },
      { alias: "api", path: "apps/api" },
      { alias: "shared", path: "libs/shared" },
    ],
    theme,
    () => {},
  );

  browser.handleInput("a");
  browser.handleInput("p");
  browser.handleInput("i");

  const text = renderText(browser);
  assert.match(text, /Search workspaces by alias or path/);
  assert.match(text, /api/);
  assert.match(text, /apps\/api/);
  assert.doesNotMatch(text, /web/);
  assert.doesNotMatch(text, /shared/);
});

test("workspace browser renders all entries without filter", () => {
  const browser = new WorkspaceBrowser(
    [
      { alias: "web", path: "apps/web" },
      { alias: "api", path: "apps/api" },
    ],
    theme,
    () => {},
  );

  const text = renderText(browser);
  assert.match(text, /web/);
  assert.match(text, /apps\/web/);
  assert.match(text, /api/);
  assert.match(text, /apps\/api/);
  assert.match(text, /2 workspace\(s\)/);
  assert.match(text, /2 match\(es\)/);
});
