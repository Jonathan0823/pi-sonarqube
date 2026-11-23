import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type {
  SonarIssue,
  SonarAnalysisState,
  SonarIssueFetchOptions,
  SonarInitConfig,
  InitCommandOptions,
  FileDuplication,
  SessionStateStore,
} from "./core/types.js";
import {
  slugify,
  normalizeServerUrl,
  sonarProjectPropertiesPath,
  projectConfigPath as corePathProjectConfig,
  loadProjectConfig as coreLoadProjectConfig,
  saveProjectConfig as coreSaveProjectConfig,
  resolveInitTarget,
  ensureDefaultSonarProjectProperties,
  saveWorkspaceRegistry,
  resolveConfig,
} from "./core/config.js";
import {
  runSonarAction,
  type SonarActionRequest,
  type SonarActionResult,
  type SonarCoreEnv,
} from "./core/actions.js";
import {
  STATE_TYPE,
  sonarArgumentCompletions,
  parseCommandArgs,
  splitSonarArgumentContext,
  mergeAutocompleteSuggestions,
  formatIssue,
  formatSummary,
  assertIssueSelection,
  helpText,
  targetLabel,
  sonarErrorMessage,
  OPEN_REMOVED_MESSAGE,
} from "./core/commands.js";
import { issueFilterLabel, normalizeIssueFilters } from "./core/api.js";
import {
  startAnalysisUi,
  showIssueBrowser,
  openIssuePreview,
  showDuplicationBrowser,
  pickOrResolveTarget,
} from "./ui.js";

const SonarToolParams = Type.Object({
  action: StringEnum(["analyze", "issues", "metrics", "duplications"] as const),
  path: Type.Optional(
    Type.String({
      description:
        "Configured target alias or SonarQube project root directory. Selects the project/configuration; never use it to filter by source file or subdirectory. Use pathScope for that.",
    }),
  ),
  issueKeys: Type.Optional(
    Type.Array(Type.String({ description: "Stable SonarQube issue key" }), {
      description: "issues: filter to one to 10 stable issue keys",
      minItems: 1,
      maxItems: 10,
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "issues/analyze: maximum issues to show (default 10; values above 100 are clamped to 100). When more match, the response ends with a breakdown of the rest by severity, rule and file.",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "issues/analyze: 0-based number of issues to skip, for paging through a long list (default 0).",
    }),
  ),
  severities: Type.Optional(
    Type.Array(
      Type.String({ description: "Issue severity to fetch (e.g. CRITICAL)" }),
    ),
  ),
  statuses: Type.Optional(
    Type.Array(
      Type.String({ description: "Issue status to fetch (e.g. OPEN)" }),
    ),
  ),
  types: Type.Optional(
    Type.Array(Type.String({ description: "Issue type to fetch (e.g. BUG)" })),
  ),
  rules: Type.Optional(
    Type.Array(Type.String({ description: "Rule keys to fetch" })),
  ),
  softwareQualities: Type.Optional(
    Type.Array(
      Type.String({
        description: "Software quality to fetch (e.g. MAINTAINABILITY)",
      }),
    ),
  ),
  impactSeverities: Type.Optional(
    Type.Array(
      Type.String({ description: "Impact severity to fetch (e.g. HIGH)" }),
    ),
  ),
  pathScope: Type.Optional(
    Type.String({
      description:
        "File or directory inside the selected SonarQube project, relative to its project root (e.g. src/api.ts or src/). Filters issues only; use path to select the project.",
    }),
  ),
  fileIndex: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "duplications: 1-based file number from the list; returns that file's duplicated blocks and line ranges.",
    }),
  ),
});

// ── State restoration ───────────────────────────────────────────────────────

function restoreState(
  ctx: ExtensionContext,
  statesByBaseDir: Map<string, SonarAnalysisState>,
): SonarAnalysisState | undefined {
  statesByBaseDir.clear();
  let latest: SonarAnalysisState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "custom" &&
      entry.customType === STATE_TYPE &&
      entry.data
    ) {
      latest = entry.data as SonarAnalysisState;
      statesByBaseDir.set(latest.baseDir, latest);
    }
  }
  ctx.ui.setStatus("sonarqube", undefined);
  return latest;
}

function handleToolControlAction(
  action: string,
  ctx: ExtensionCommandContext,
  enabled: boolean,
  toggle: (enabled: boolean) => void,
): boolean {
  if (action === "on" || action === "enable") {
    if (!enabled) toggle(true);
    ctx.ui.notify("SonarQube tool enabled", "info");
    return true;
  }
  if (action === "off" || action === "disable") {
    if (enabled) toggle(false);
    ctx.ui.notify("SonarQube tool disabled", "info");
    return true;
  }
  if (action === "status") {
    ctx.ui.notify(
      enabled
        ? "SonarQube tool enabled"
        : "SonarQube tool disabled; run /sonarqube on to enable it",
      "info",
    );
    return true;
  }
  return false;
}

// ── Init command helpers (extracted to reduce cognitive complexity) ─────────

async function confirmOverwrite(
  ctx: ExtensionCommandContext,
  baseDir: string,
  existing: SonarInitConfig,
): Promise<boolean> {
  const ok = await ctx.ui.confirm(
    "Overwrite?",
    [
      `SonarQube config already exists at ${baseDir}:`,
      `  Server: ${existing.serverUrl}`,
      `  Project: ${existing.projectKey}`,
      "",
      "Overwrite?",
    ].join("\n"),
  );
  if (ok) return true;
  if (ctx.hasUI) ctx.ui.notify("Init cancelled.", "info");
  return false;
}

async function collectInitInputs(
  ctx: ExtensionCommandContext,
  existing: SonarInitConfig | undefined,
  baseDir: string,
): Promise<
  | { serverUrl: string; projectKey: string; token: string | undefined }
  | undefined
> {
  const serverUrlInput = await ctx.ui.editor(
    "SonarQube server URL",
    existing?.serverUrl ?? "http://localhost:9000",
  );
  if (serverUrlInput === undefined) return undefined;
  const serverUrl = normalizeServerUrl(
    serverUrlInput || existing?.serverUrl || "http://localhost:9000",
  );

  const projectKeyInput = await ctx.ui.input(
    "SonarQube project key",
    existing?.projectKey ?? basename(baseDir),
  );
  if (projectKeyInput === undefined) return undefined;
  const projectKey =
    projectKeyInput || existing?.projectKey || slugify(basename(baseDir));

  const tokenInput = await ctx.ui.input(
    "SonarQube token (optional, press Enter to skip)",
    existing?.token ?? "",
  );
  if (tokenInput === undefined) return undefined;

  return { serverUrl, projectKey, token: tokenInput.trim() || undefined };
}

async function initCommandHandler(
  ctx: ExtensionCommandContext,
  options: InitCommandOptions = {},
): Promise<void> {
  let { alias, targetInput } = options;
  if (!alias && !targetInput) {
    const pickResult = await pickOrResolveTarget(ctx);
    if (pickResult === null) return;
    if (pickResult !== undefined) targetInput = pickResult;
  }
  const { baseDir, repoRoot } = await resolveInitTarget(
    { cwd: ctx.cwd, configDirName: CONFIG_DIR_NAME },
    alias,
    targetInput,
  );
  const existing = await coreLoadProjectConfig(baseDir, CONFIG_DIR_NAME);

  const confirmed = existing
    ? await confirmOverwrite(ctx, baseDir, existing)
    : true;
  if (!confirmed) return;

  const inputs = await collectInitInputs(ctx, existing, baseDir);
  if (!inputs) return;

  await coreSaveProjectConfig(baseDir, inputs, CONFIG_DIR_NAME);
  const propertiesState = await ensureDefaultSonarProjectProperties(baseDir);

  if (options.alias) {
    await saveWorkspaceRegistry(
      repoRoot,
      options.alias,
      baseDir,
      CONFIG_DIR_NAME,
    );
  }

  if (ctx.hasUI) {
    notifyInitResult(ctx, baseDir, propertiesState, options.alias);
  }
}

function notifyInitResult(
  ctx: ExtensionCommandContext,
  baseDir: string,
  propertiesState: "created" | "updated" | "unchanged",
  alias?: string,
): void {
  const label = alias ? ` (${alias})` : "";
  let note = "";
  if (propertiesState === "created") {
    note = ` and created ${sonarProjectPropertiesPath(baseDir)}`;
  } else if (propertiesState === "updated") {
    note = ` and merged ${sonarProjectPropertiesPath(baseDir)}`;
  }
  ctx.ui.notify(
    `SonarQube config saved${label} to ${corePathProjectConfig(baseDir, CONFIG_DIR_NAME)}${note}`,
    "info",
  );
}

// ── Tool result rendering helpers (reduces renderResult complexity) ─────────

function renderErrorResult(errorMsg: string, theme: Theme): Text {
  return new Text(theme.fg("error", errorMsg), 0, 0);
}

function renderEmptyResult(summary: string, theme: Theme): Text {
  return new Text(theme.fg("success", summary), 0, 0);
}

function renderIssueResult(
  issue: SonarIssue,
  contentText: string | undefined,
  theme: Theme,
): Text {
  const text = contentText ?? formatIssue(issue);
  const preview = text.split("\n").slice(1).join("\n");
  const label = theme.fg("accent", formatIssue(issue, undefined, false));
  return new Text(preview ? `${label}\n${preview}` : label, 0, 0);
}

function renderIssueBatchResult(
  issues: SonarIssue[],
  missingIssueKeys: string[],
  contentText: string | undefined,
  theme: Theme,
): Text {
  if (contentText) {
    const hiddenKeys = issues.reduce(
      (text, issue) =>
        text.replace(formatIssue(issue), formatIssue(issue, undefined, false)),
      contentText,
    );
    const hiddenMissingKeys = missingIssueKeys.reduce(
      (text, key) =>
        text.replace(
          `Issue key "${key}" was not found.`,
          "Requested issue was not found.",
        ),
      hiddenKeys,
    );
    return new Text(hiddenMissingKeys, 0, 0);
  }
  const lines = issues.map((issue) =>
    theme.fg("accent", formatIssue(issue, undefined, false)),
  );
  if (missingIssueKeys.length > 0) {
    lines.push(
      theme.fg("error", "One or more requested issues were not found."),
    );
  }
  return new Text(lines.join("\n"), 0, 0);
}

function renderIssueListResult(
  state: SonarAnalysisState,
  expanded: boolean,
  theme: Theme,
): Text {
  const summary = formatSummary(state);
  if (state.issues.length === 0 && !state.measures) {
    return new Text(theme.fg("success", summary), 0, 0);
  }

  const lines: string[] = [];
  lines.push(theme.fg("accent", summary));
  if (state.measures) {
    const density = state.measures.duplicatedLinesDensity.toFixed(1);
    const detail =
      state.measures.duplicatedBlocks > 0
        ? `Duplication: ${density}%  lines=${state.measures.duplicatedLines}  blocks=${state.measures.duplicatedBlocks}  files=${state.measures.duplicatedFiles}`
        : `Duplication: ${density}%  (no duplications detected)`;
    lines.push(theme.fg("dim", detail));
  }

  if (state.issues.length === 0) {
    return new Text(lines.join("\n"), 0, 0);
  }

  const visible = expanded ? state.issues : state.issues.slice(0, 5);
  for (const [i, issue] of visible.entries()) {
    lines.push(theme.fg("muted", formatIssue(issue, i + 1, false)));
  }
  if (!expanded && state.issues.length > visible.length) {
    lines.push(
      theme.fg("dim", `... ${state.issues.length - visible.length} more`),
    );
  }
  return new Text(lines.join("\n"), 0, 0);
}

// ── Extension entrypoint ────────────────────────────────────────────────────

// ponytail: lazy config cache so rule autocomplete can fetch from the server
let _cachedConfig:
  { serverUrl: string; projectKey: string; token?: string } | undefined;

async function cachedServerConfig(cwd: string): Promise<typeof _cachedConfig> {
  if (!_cachedConfig) {
    try {
      const cfg = await resolveConfig({
        cwd,
        configDirName: CONFIG_DIR_NAME,
      });
      _cachedConfig = {
        serverUrl: cfg.serverUrl,
        projectKey: cfg.projectKey,
        token: cfg.token,
      };
    } catch {
      // fall through
    }
  }
  return _cachedConfig;
}

const SONARQUBE_COMMAND_PREFIX = "/sonarqube";
const SONARQUBE_TOOL_ENABLED_ENTRY_TYPE = "sonarqube-tool-enabled";

/** Text after "/sonarqube " in an autocomplete prefix, or undefined if it isn't a /sonarqube command. */
export function sonarqubeArgumentText(prefix: string): string | undefined {
  if (!prefix.startsWith(SONARQUBE_COMMAND_PREFIX)) return undefined;
  const rest = prefix.slice(SONARQUBE_COMMAND_PREFIX.length);
  if (rest === "") return "";
  const trimmed = rest.trimStart();
  if (trimmed === rest) return undefined; // no whitespace after the command
  return trimmed;
}

export default function sonarqube(pi: ExtensionAPI) {
  const statesByBaseDir = new Map<string, SonarAnalysisState>();
  let latestState: SonarAnalysisState | undefined;
  let sonarqubeToolEnabled = false;

  const setSonarqubeToolEnabled = (enabled: boolean) => {
    const active = new Set(pi.getActiveTools());
    if (enabled) active.add("sonarqube");
    else active.delete("sonarqube");
    pi.setActiveTools(Array.from(active));
    sonarqubeToolEnabled = enabled;
  };

  const toggleSonarqubeTool = (enabled: boolean) => {
    setSonarqubeToolEnabled(enabled);
    pi.appendEntry(SONARQUBE_TOOL_ENABLED_ENTRY_TYPE, { on: enabled });
  };

  const rememberState = (state: SonarAnalysisState) => {
    statesByBaseDir.set(state.baseDir, state);
    latestState = state;
  };

  const store: SessionStateStore = {
    get: (baseDir) => statesByBaseDir.get(baseDir),
    remember: rememberState,
    persist: (state) => pi.appendEntry(STATE_TYPE, state),
  };

  const coreEnv = (ctx: ExtensionContext): SonarCoreEnv => ({
    cwd: ctx.cwd,
    signal: ctx.signal,
    configDirName: CONFIG_DIR_NAME,
    exec: (command, args, options) => pi.exec(command, args, options),
    store,
    startProgress: (config) => {
      _cachedConfig = {
        serverUrl: config.serverUrl,
        projectKey: config.projectKey,
        token: config.token,
      };
      return startAnalysisUi(ctx, config.projectKey);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    let wantToolEnabled = false;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        entry.customType === SONARQUBE_TOOL_ENABLED_ENTRY_TYPE
      ) {
        const data = entry.data as { on?: unknown } | undefined;
        if (typeof data?.on === "boolean") wantToolEnabled = data.on;
      }
    }
    setSonarqubeToolEnabled(wantToolEnabled);
    latestState = restoreState(ctx, statesByBaseDir);

    if (ctx.hasUI) {
      if (!wantToolEnabled) {
        ctx.ui.notify(
          "SonarQube tool is disabled; run /sonarqube on to enable it",
          "info",
        );
      }
      ctx.ui.addAutocompleteProvider((current) => ({
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const line = lines[cursorLine] ?? "";
          const beforeCursor = line.slice(0, cursorCol);
          const argumentText = sonarqubeArgumentText(beforeCursor);
          if (argumentText === undefined)
            return current.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              options,
            );
          const { current: currentToken } =
            splitSonarArgumentContext(argumentText);
          const cfg = await cachedServerConfig(ctx.cwd);
          const extraItems =
            (await sonarArgumentCompletions(argumentText, {
              issues: latestState?.issues,
              mode: latestState?.cleanCodeMode,
              serverUrl: cfg?.serverUrl,
              token: cfg?.token,
              projectKey: cfg?.projectKey,
              configDirName: CONFIG_DIR_NAME,
            })) ?? [];
          const currentSuggestions = await current.getSuggestions(
            lines,
            cursorLine,
            cursorCol,
            options,
          );
          const merged = mergeAutocompleteSuggestions(
            currentToken,
            currentSuggestions,
            extraItems,
          );
          return merged ?? currentSuggestions;
        },

        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return current.applyCompletion(
            lines,
            cursorLine,
            cursorCol,
            item,
            prefix,
          );
        },

        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          return (
            current.shouldTriggerFileCompletion?.(
              lines,
              cursorLine,
              cursorCol,
            ) ?? true
          );
        },
      }));
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    latestState = restoreState(ctx, statesByBaseDir);
  });

  pi.registerTool({
    name: "sonarqube",
    label: "SonarQube",
    description: "Run local SonarQube analysis and inspect the latest issues.",
    promptSnippet: "Run local SonarQube analysis or inspect issue results",
    promptGuidelines: [
      "Use sonarqube when the user asks to run a local SonarQube scan, inspect issues.",
      "The `path` parameter selects a configured target alias or SonarQube project root. Never pass a source file or subdirectory as `path`.",
      "Use `pathScope` for a file or directory inside that project. Example: path: 'apps/web', pathScope: 'src/components/'.",
      "Use the optional severity, status, type, rule, quality, and impact severity filters to fetch only the most relevant issues.",
      "Flow: list issues, page or filter (use `issueKeys` to fetch specific issues), then read the files at the reported file:line locations.",
    ],
    parameters: SonarToolParams,

    // Runs before schema validation, so removed legacy fields get a guiding
    // error instead of a generic enum/unknown-property failure.
    prepareArguments(args) {
      const input = (args ?? {}) as { action?: unknown; issueIndex?: unknown };
      if (input.action === "open" || input.issueIndex !== undefined) {
        throw new Error(OPEN_REMOVED_MESSAGE);
      }
      return args as Static<typeof SonarToolParams>;
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        // Defense in depth for callers that skip prepareArguments.
        const legacy = params as { action: string; issueIndex?: unknown };
        if (legacy.action === "open" || legacy.issueIndex !== undefined) {
          throw new Error(OPEN_REMOVED_MESSAGE);
        }
        const result = await runSonarAction(
          params as SonarActionRequest,
          coreEnv(ctx),
        );
        return {
          content: (result.blocks ?? [result.text]).map((text) => ({
            type: "text" as const,
            text,
          })),
          details: result.details,
        };
      } catch (error) {
        const msg = sonarErrorMessage(error);
        return {
          content: [{ type: "text", text: msg }],
          details: { error: msg },
        };
      }
    },

    renderCall(args, theme, _context) {
      const filters = normalizeIssueFilters({
        severities: args.severities,
        statuses: args.statuses,
        types: args.types,
        rules: args.rules,
        softwareQualities: args.softwareQualities,
        impactSeverities: args.impactSeverities,
        issueKeys: args.issueKeys,
        pathScope: args.pathScope,
      });
      const filterText = filters
        ? ` ${theme.fg("muted", issueFilterLabel(filters))}`
        : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("sonarqube"))} ${theme.fg("muted", String(args.action))}${
          args.path ? ` ${theme.fg("accent", args.path)}` : ""
        }${filterText}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, _context) {
      const state = result.details as
        | SonarAnalysisState
        | {
            error?: string;
            selectedIssue?: SonarIssue;
            selectedIssues?: SonarIssue[];
            missingIssueKeys?: string[];
          }
        | undefined;

      if (!state) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      if ("error" in state && state.error) {
        return renderErrorResult(state.error, theme);
      }

      const contentText =
        result.content[0]?.type === "text" ? result.content[0].text : undefined;

      if ("selectedIssue" in state && state.selectedIssue) {
        return renderIssueResult(state.selectedIssue, contentText, theme);
      }

      if ("selectedIssues" in state && state.selectedIssues) {
        return renderIssueBatchResult(
          state.selectedIssues,
          state.missingIssueKeys ?? [],
          contentText,
          theme,
        );
      }

      if ("issues" in state) {
        return renderIssueListResult(state, expanded, theme);
      }

      return new Text(
        result.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n"),
        0,
        0,
      );
    },
  });

  pi.registerCommand("sonarqube", {
    description:
      "Run a local SonarQube analysis, browse the latest issues, or init project config",
    getArgumentCompletions: async (argumentPrefix) => {
      const cfg = await cachedServerConfig(process.cwd());
      return sonarArgumentCompletions(argumentPrefix, {
        issues: latestState?.issues,
        mode: latestState?.cleanCodeMode,
        cwd: process.cwd(),
        serverUrl: cfg?.serverUrl,
        token: cfg?.token,
        projectKey: cfg?.projectKey,
        configDirName: CONFIG_DIR_NAME,
      });
    },
    handler: async (args, ctx) => {
      const run: RunAction = (request) => runSonarAction(request, coreEnv(ctx));
      try {
        const action = (args || "").trim().toLowerCase();
        if (
          handleToolControlAction(
            action,
            ctx,
            sonarqubeToolEnabled,
            toggleSonarqubeTool,
          )
        ) {
          return;
        }

        const parsed = parseCommandArgs(args);
        if (
          !sonarqubeToolEnabled &&
          parsed.action !== "help" &&
          parsed.action !== "init"
        ) {
          ctx.ui.notify(
            "SonarQube is disabled; run /sonarqube on before scanning or querying results",
            "warning",
          );
          return;
        }

        switch (parsed.action) {
          case "help":
            if (ctx.hasUI) ctx.ui.notify(helpText(), "info");
            return;
          case "init":
            await initCommandHandler(ctx, {
              alias: parsed.alias,
              targetInput: parsed.targetInput,
            });
            return;
          case "analyze":
            await commandAnalyze(ctx, run, parsed.targetInput, parsed.filters);
            return;
          case "metrics":
            await commandMetrics(ctx, run, parsed.targetInput);
            return;
          case "duplications":
            await commandDuplications(
              ctx,
              run,
              parsed.targetInput,
              parsed.issueIndex,
              parsed.filters,
            );
            return;
          default:
            await commandIssuesOrOpen(ctx, run, parsed);
        }
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(sonarErrorMessage(error), "error");
          return;
        }
        throw error;
      }
    },
  });
}

type RunAction = (request: SonarActionRequest) => Promise<SonarActionResult>;

type SoftDetails = { error?: string; code?: string; cause?: unknown };

/** Config failures surface as the original error in command mode. */
function rethrowConfigError(details: SoftDetails): void {
  if (details.code === "not_configured") throw details.cause;
}

async function commandAnalyze(
  ctx: ExtensionContext,
  run: RunAction,
  targetInput: string | undefined,
  filters: SonarIssueFetchOptions | undefined,
): Promise<void> {
  if (!targetInput) {
    const pickResult = await pickOrResolveTarget(ctx);
    if (pickResult === null) return; // user cancelled
    targetInput = pickResult;
  }
  const result = await run({
    action: "analyze",
    path: targetInput,
    ...filters,
  });
  const state = result.details as SonarAnalysisState;
  if (ctx.hasUI) {
    const scope = targetLabel(targetInput);
    ctx.ui.notify(
      `${formatSummary(state)}. Use /sonarqube issues${scope} to browse.`,
      state.issues.length === 0 ? "info" : "warning",
    );
  }
}

async function commandMetrics(
  ctx: ExtensionCommandContext,
  run: RunAction,
  targetInput?: string,
): Promise<void> {
  if (!targetInput) {
    const pickResult = await pickOrResolveTarget(ctx);
    if (pickResult === null) return;
    targetInput = pickResult;
  }
  const result = await run({ action: "metrics", path: targetInput });
  const details = result.details as SoftDetails;
  rethrowConfigError(details);
  if (ctx.hasUI) {
    ctx.ui.notify(result.text, details.error ? "warning" : "info");
  }
}

async function resolveTargetInput(
  ctx: ExtensionCommandContext,
  targetInput?: string,
): Promise<string | null | undefined> {
  return targetInput || pickOrResolveTarget(ctx);
}

async function commandDuplications(
  ctx: ExtensionCommandContext,
  run: RunAction,
  targetInput?: string,
  fileIndex?: number,
  filters?: SonarIssueFetchOptions,
): Promise<void> {
  const resolvedTarget = await resolveTargetInput(ctx, targetInput);
  if (resolvedTarget === null) return;
  targetInput = resolvedTarget;
  const request = {
    action: "duplications",
    path: targetInput,
    pathScope: filters?.pathScope,
  } as const;
  const result = await run(
    fileIndex === undefined
      ? { ...request, view: "list" }
      : { ...request, fileIndex },
  );
  const details = result.details as SoftDetails & { files?: FileDuplication[] };
  rethrowConfigError(details);
  const softNotices: Record<string, [string, "warning" | "info" | "error"]> = {
    forbidden: [
      "SonarQube token needs 'See Source Code' permission to list duplicated files. Update the token permissions in SonarQube and run /sonarqube init to update the token.",
      "warning",
    ],
    no_duplications: ["No duplications found.", "info"],
    file_not_found: [result.text, "error"],
  };
  const notice = details.code ? softNotices[details.code] : undefined;
  if (notice) {
    if (ctx.hasUI) ctx.ui.notify(...notice);
    return;
  }

  if (fileIndex !== undefined) {
    if (ctx.mode === "tui") {
      await ctx.ui.editor(
        `Duplications in ${(details as { filePath?: string }).filePath}`,
        result.text,
      );
    } else if (ctx.hasUI) {
      ctx.ui.notify(result.text, "info");
    }
    return;
  }

  if (ctx.mode !== "tui") {
    ctx.ui.notify(result.text, "info");
    return;
  }
  const scopeLabel = filters?.pathScope ? issueFilterLabel(filters) : undefined;
  const choice = await showDuplicationBrowser(
    ctx,
    details.files ?? [],
    scopeLabel,
  );
  if (choice == null) return;
  const selected = await run({ ...request, fileIndex: choice + 1 });
  if (selected.soft) {
    ctx.ui.notify(selected.text, "warning");
    return;
  }
  ctx.ui.setEditorText(selected.text);
  ctx.ui.notify("Duplication loaded into editor — press Enter to send", "info");
}

type IssueCommandArgs = {
  targetInput?: string;
  filters?: SonarIssueFetchOptions;
  action: string;
  issueIndex?: number;
  issueKeys?: string[];
};

async function commandIssuesOrOpen(
  ctx: ExtensionCommandContext,
  run: RunAction,
  parsed: IssueCommandArgs,
): Promise<void> {
  assertIssueSelection(parsed.issueIndex, parsed.issueKeys);
  const targetInput = await resolveTargetInput(ctx, parsed.targetInput);
  if (targetInput === null) return;
  const result = await run({
    ...parsed.filters,
    action: parsed.action === "issues" ? "issues" : "open",
    path: targetInput,
    issueIndex: parsed.issueIndex,
    issueKeys: parsed.issueKeys,
  });
  const details = result.details as SoftDetails;
  if (details.code === "no_analysis") {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `No SonarQube analysis found for this target. Run /sonarqube analyze${targetLabel(parsed.targetInput)} first.`,
        "warning",
      );
    }
    return;
  }

  if (parsed.action === "issues") {
    await commandShowIssues(ctx, result.details as SonarAnalysisState);
    return;
  }
  if (parsed.issueKeys?.length) {
    const { missingIssueKeys } = result.details as {
      missingIssueKeys: string[];
    };
    await showIssueKeyPreviews(ctx, result.text, missingIssueKeys.length > 0);
    return;
  }
  if (details.code === "issue_not_found") {
    if (ctx.hasUI) ctx.ui.notify(result.text, "error");
    return;
  }
  const state = result.details as SonarAnalysisState & {
    selectedIssue: SonarIssue;
  };
  await openIssuePreview(ctx, state, state.selectedIssue);
}

async function showIssueKeyPreviews(
  ctx: ExtensionCommandContext,
  text: string,
  hasMissing: boolean,
): Promise<void> {
  if (ctx.mode === "tui") {
    await ctx.ui.editor("SonarQube issue previews", text);
  } else if (ctx.hasUI) {
    ctx.ui.notify(text, hasMissing ? "warning" : "info");
  }
}

async function commandShowIssues(
  ctx: ExtensionCommandContext,
  targetState: SonarAnalysisState,
): Promise<void> {
  if (targetState.issues.length === 0) {
    if (ctx.hasUI) ctx.ui.notify(formatSummary(targetState), "info");
    return;
  }
  const choice = await showIssueBrowser(ctx, targetState);
  if (choice != null) {
    const issue = targetState.issues[choice];
    if (issue) {
      const line = issue.line ? `:${issue.line}` : "";
      const rule = issue.ruleName
        ? `${issue.rule} (${issue.ruleName})`
        : issue.rule;
      ctx.ui.setEditorText(
        `${issue.severity} ${issue.filePath}${line} — ${rule} — ${issue.message}`,
      );
      ctx.ui.notify("Issue loaded into editor — press Enter to send", "info");
    }
  }
}

// ── Re-exports for public API ───────────────────────────────────────────────

export type {
  SonarAction,
  SonarIssue,
  SonarAnalysisState,
  SonarProjectConfig,
  SonarIssueFetchOptions,
  SonarInitConfig,
  IssueQualityCounts,
} from "./core/types.js";

export const projectConfigPath = (baseDir: string) =>
  corePathProjectConfig(baseDir, CONFIG_DIR_NAME);

export const loadProjectConfig = (baseDir: string) =>
  coreLoadProjectConfig(baseDir, CONFIG_DIR_NAME);

export const saveProjectConfig = (baseDir: string, config: SonarInitConfig) =>
  coreSaveProjectConfig(baseDir, config, CONFIG_DIR_NAME);
