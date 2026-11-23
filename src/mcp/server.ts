#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { z } from "zod";
import {
  runSonarAction,
  type SonarActionRequest,
  type SonarCoreEnv,
} from "../core/actions.js";
import { sonarErrorMessage } from "../core/commands.js";
import { initProject } from "../core/init.js";
import { OPEN_REMOVED_MESSAGE } from "../core/commands.js";
import type { CommandRunner, SonarAnalysisState } from "../core/types.js";

const DESCRIPTION = [
  "Run local SonarQube analysis and inspect the latest issues.",
  "Use sonarqube when the user asks to run a local SonarQube scan or inspect issues.",
  "The `path` parameter selects a configured target alias or SonarQube project root. Never pass a source file or subdirectory as `path`.",
  "Use `pathScope` for a file or directory inside that project. Example: path: 'apps/web', pathScope: 'src/components/'.",
  "Use the optional severity, status, type, rule, quality, and impact severity filters to fetch only the most relevant issues.",
  "Use action 'init' once per project to write .claude/sonarqube.json; it takes optional path, serverUrl, projectKey and token. Prefer the SONARQUBE_TOKEN or SONAR_TOKEN environment variable over passing token.",
  "Flow: list issues, page or filter (use `issueKeys` to fetch specific issues), then read the files at the reported file:line locations with your own file tools.",
].join("\n");

const list = (description: string) =>
  z.array(z.string()).optional().describe(description);

const inputSchema = {
  action: z.enum(["analyze", "issues", "metrics", "duplications", "init"], {
    error: (issue) =>
      issue.input === "open" ? OPEN_REMOVED_MESSAGE : undefined,
  }),
  serverUrl: z
    .string()
    .optional()
    .describe("init: SonarQube server URL (default http://localhost:9000)"),
  projectKey: z
    .string()
    .optional()
    .describe("init: SonarQube project key (default: directory slug)"),
  token: z
    .string()
    .optional()
    .describe(
      "init: SonarQube token. Prefer the SONARQUBE_TOKEN or SONAR_TOKEN environment variable so secrets stay out of the transcript.",
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Configured target alias or SonarQube project root directory. Selects the project/configuration; never use it to filter by source file or subdirectory. Use pathScope for that.",
    ),
  issueKeys: z
    .array(z.string().describe("Stable SonarQube issue key"))
    .min(1)
    .max(10)
    .optional()
    .describe("issues: filter to one to 10 stable issue keys"),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "issues/analyze: maximum issues to show (default 10; values above 100 are clamped to 100). When more match, the response ends with a breakdown of the rest by severity, rule and file.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "issues/analyze: 0-based number of issues to skip, for paging through a long list (default 0).",
    ),
  severities: list("Issue severities to fetch (e.g. CRITICAL)"),
  statuses: list("Issue statuses to fetch (e.g. OPEN)"),
  types: list("Issue types to fetch (e.g. BUG)"),
  rules: list("Rule keys to fetch"),
  softwareQualities: list("Software qualities to fetch (e.g. MAINTAINABILITY)"),
  impactSeverities: list("Impact severities to fetch (e.g. HIGH)"),
  view: z
    .enum(["list"])
    .optional()
    .describe(
      "duplications: 'list' returns the duplicated files without code previews.",
    ),
  fileIndex: z
    .number()
    .optional()
    .describe(
      "duplications: 1-based file number from the list; returns that file's duplicated blocks and line ranges.",
    ),
  pathScope: z
    .string()
    .optional()
    .describe(
      "File or directory inside the selected SonarQube project, relative to its project root (e.g. src/api.ts or src/). Filters issues only; use path to select the project.",
    ),
};

const exec: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options?.cwd,
        signal: options?.signal,
        timeout: options?.timeout,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        let code = 1;
        if (error === null) code = 0;
        else if (typeof error.code === "number") code = error.code;
        resolve({
          stdout,
          stderr: stderr || (error && code === 1 ? error.message : ""),
          code,
          killed: error?.killed,
        });
      },
    );
  });

const states = new Map<string, SonarAnalysisState>();

const { version } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};
const server = new McpServer({ name: "sonarqube", version });

const inputObject = z.looseObject(inputSchema).superRefine((value, ctx) => {
  if ("issueIndex" in value) {
    ctx.addIssue({ code: "custom", message: OPEN_REMOVED_MESSAGE });
  }
});

server.registerTool(
  "sonarqube",
  { description: DESCRIPTION, inputSchema: inputObject },
  async (params, extra) => {
    const env: SonarCoreEnv = {
      cwd: process.cwd(),
      signal: extra.signal,
      configDirName: ".claude",
      commandHint: (command) => `/sonarqube-${command}`,
      positionalOpenFromSession: true,
      strictTargetPath: true,
      exec,
      store: {
        get: (baseDir) => states.get(baseDir),
        remember: (state) => {
          states.set(state.baseDir, state);
        },
        persist: (state) => {
          states.set(state.baseDir, state);
        },
      },
    };
    try {
      if (params.action === "init") {
        const text = await initProject(params, env);
        return { content: [{ type: "text" as const, text }] };
      }
      const result = await runSonarAction(params as SonarActionRequest, env);
      return {
        isError: result.soft === true,
        content: (result.blocks ?? [result.text]).map((text) => ({
          type: "text" as const,
          text,
        })),
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: sonarErrorMessage(error) }],
      };
    }
  },
);

await server.connect(new StdioServerTransport());
