import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type {
  SonarIssue,
  SonarAnalysisState,
  SonarIssueFetchOptions,
  SonarInitConfig,
  InitCommandOptions,
} from "./types.js";
import {
  slugify,
  normalizeServerUrl,
  sonarProjectPropertiesPath,
  projectConfigPath,
  resolveInitTarget,
  loadProjectConfig,
  saveProjectConfig,
  ensureDefaultSonarProjectProperties,
  saveWorkspaceRegistry,
  resolveConfig,
} from "./config.js";
import {
  runScanner,
  readReportTask,
  waitForAnalysis,
  normalizeIssueFilters,
  fetchIssues,
  fetchDuplicationMeasures,
  fetchIssueSeverityCounts,
  createAnalysisState,
  issueFilterLabel,
} from "./api.js";
import {
  STATE_TYPE,
  sonarArgumentCompletions,
  parseCommandArgs,
  splitSonarArgumentContext,
  mergeAutocompleteSuggestions,
  formatIssue,
  formatSummary,
  formatMetricsOutput,
  formatReport,
  helpText,
  targetLabel,
  sonarErrorMessage,
} from "./commands.js";

import {
  startAnalysisUi,
  showIssueBrowser,
  buildIssuePreview,
  openIssuePreview,
  resolveTargetState,
} from "./ui.js";

const SonarToolParams = Type.Object({
  action: StringEnum(["analyze", "issues", "open", "metrics"] as const),
  path: Type.Optional(Type.String({ description: "Target alias or project directory to analyze or inspect" })),
  issueIndex: Type.Optional(Type.Number({ description: "1-based issue index to open" })),
  severities: Type.Optional(
    Type.Array(Type.String({ description: "Issue severity to fetch (e.g. CRITICAL)" })),
  ),
  statuses: Type.Optional(
    Type.Array(Type.String({ description: "Issue status to fetch (e.g. OPEN)" })),
  ),
  types: Type.Optional(Type.Array(Type.String({ description: "Issue type to fetch (e.g. BUG)" }))),
  rules: Type.Optional(Type.Array(Type.String({ description: "Rule keys to fetch" }))),
});

// ── State restoration ───────────────────────────────────────────────────────

async function restoreState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  statesByBaseDir: Map<string, SonarAnalysisState>,
): Promise<SonarAnalysisState | undefined> {
  statesByBaseDir.clear();
  let latest: SonarAnalysisState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === STATE_TYPE && entry.data) {
      latest = entry.data as SonarAnalysisState;
      statesByBaseDir.set(latest.baseDir, latest);
    }
  }
  ctx.ui.setStatus("sonarqube", undefined);
  return latest;
}

// ── Analysis orchestration ──────────────────────────────────────────────────

async function analyzeProject(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  inputPath?: string,
  filters?: SonarIssueFetchOptions,
): Promise<SonarAnalysisState> {
  const config = await resolveConfig(ctx, inputPath);
  const baseDirStat = await stat(config.baseDir).catch(() => undefined);
  if (!baseDirStat?.isDirectory()) {
    throw new Error(`Project directory not found: ${config.baseDir}`);
  }

  const analysisUi = startAnalysisUi(ctx, config.projectKey);

  try {
    analysisUi.setPhase("Running sonar-scanner...");
    await runScanner(pi, config, ctx.signal);

    analysisUi.setPhase("Reading scanner report...");
    const report = await readReportTask(config.baseDir);
    const ceTaskUrl = report["ceTaskUrl"];
    const dashboardUrl = report["dashboardUrl"];
    const analysisId = ceTaskUrl
      ? (analysisUi.setPhase("Waiting for SonarQube analysis..."),
        await waitForAnalysis(config.serverUrl, config.token, ceTaskUrl, ctx.signal))
      : undefined;

    analysisUi.setPhase("Fetching issues...");
    const normalizedFilters = normalizeIssueFilters(filters);
    const issues = await fetchIssues(
      config.serverUrl,
      config.token,
      config.projectKey,
      ctx.signal,
      normalizedFilters,
    );

    analysisUi.setPhase("Fetching metrics...");
    const measures = await fetchDuplicationMeasures(
      config.serverUrl,
      config.token,
      config.projectKey,
      ctx.signal,
    );

    const state = createAnalysisState(config, issues, {
      dashboardUrl,
      ceTaskUrl,
      analysisId,
      filters: normalizedFilters,
      measures,
    });

    pi.appendEntry(STATE_TYPE, state);
    return state;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    analysisUi.stop();
  }
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
): Promise<{ serverUrl: string; projectKey: string; token: string | undefined } | undefined> {
  const serverUrlInput = await ctx.ui.editor("SonarQube server URL", existing?.serverUrl ?? "http://localhost:9000");
  if (serverUrlInput === undefined) return undefined;
  const serverUrl = normalizeServerUrl(serverUrlInput || existing?.serverUrl || "http://localhost:9000");

  const projectKeyInput = await ctx.ui.input("SonarQube project key", existing?.projectKey ?? basename(baseDir));
  if (projectKeyInput === undefined) return undefined;
  const projectKey = projectKeyInput || existing?.projectKey || slugify(basename(baseDir));

  const tokenInput = await ctx.ui.input("SonarQube token (optional, press Enter to skip)", existing?.token ?? "");
  if (tokenInput === undefined) return undefined;

  return { serverUrl, projectKey, token: tokenInput.trim() || undefined };
}

async function initCommandHandler(ctx: ExtensionCommandContext, options: InitCommandOptions = {}): Promise<void> {
  const { baseDir, repoRoot } = await resolveInitTarget(ctx, options.alias, options.targetInput);
  const existing = await loadProjectConfig(baseDir);

  const confirmed = existing ? await confirmOverwrite(ctx, baseDir, existing) : true;
  if (!confirmed) return;

  const inputs = await collectInitInputs(ctx, existing, baseDir);
  if (!inputs) return;

  await saveProjectConfig(baseDir, inputs);
  const propertiesState = await ensureDefaultSonarProjectProperties(baseDir);

  if (options.alias) {
    await saveWorkspaceRegistry(repoRoot, options.alias, baseDir);
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
  ctx.ui.notify(`SonarQube config saved${label} to ${projectConfigPath(baseDir)}${note}`, "info");
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
  expanded: boolean,
  theme: Theme,
): Text {
  const text = contentText ?? formatIssue(issue);
  const preview = expanded ? text.split("\n").slice(1).join("\n") : "";
  const label = theme.fg("accent", formatIssue(issue));
  return new Text(preview ? `${label}\n${preview}` : label, 0, 0);
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
    const detail = state.measures.duplicatedBlocks > 0
      ? `Duplication: ${density}%  lines=${state.measures.duplicatedLines}  blocks=${state.measures.duplicatedBlocks}  files=${state.measures.duplicatedFiles}`
      : `Duplication: ${density}%  (no duplications detected)`;
    lines.push(theme.fg("dim", detail));
  }

  if (state.issues.length === 0) {
    return new Text(lines.join("\n"), 0, 0);
  }

  const visible = expanded ? state.issues : state.issues.slice(0, 5);
  for (const [i, issue] of visible.entries()) {
    lines.push(theme.fg("muted", formatIssue(issue, i + 1)));
  }
  if (!expanded && state.issues.length > visible.length) {
    lines.push(theme.fg("dim", `... ${state.issues.length - visible.length} more`));
  }
  return new Text(lines.join("\n"), 0, 0);
}

// ── Extension entrypoint ────────────────────────────────────────────────────

export default function sonarqube(pi: ExtensionAPI) {
  const statesByBaseDir = new Map<string, SonarAnalysisState>();
  let latestState: SonarAnalysisState | undefined;

  const rememberState = (state: SonarAnalysisState) => {
    statesByBaseDir.set(state.baseDir, state);
    latestState = state;
  };

  const restore = async (ctx: ExtensionContext) => {
    latestState = await restoreState(pi, ctx, statesByBaseDir);
  };

  pi.on("session_start", async (_event, ctx) => {
    await restore(ctx);

    if (ctx.hasUI) {
      ctx.ui.addAutocompleteProvider((current) => ({
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const line = lines[cursorLine] ?? "";
          const beforeCursor = line.slice(0, cursorCol);
          const match = /^\/sonarqube(?:\s+(.*))?$/.exec(beforeCursor);
          if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);

          const argumentText = match[1] ?? "";
          const { current: currentToken } = splitSonarArgumentContext(argumentText);
          const extraItems = sonarArgumentCompletions(argumentText, latestState?.issues) ?? [];
          const currentSuggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
          const merged = mergeAutocompleteSuggestions(currentToken, currentSuggestions, extraItems);
          return merged ?? currentSuggestions;
        },

        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },

        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
      }));
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restore(ctx);
  });

  pi.registerTool({
    name: "sonarqube",
    label: "SonarQube",
    description: "Run local SonarQube analysis and inspect the latest issues.",
    promptSnippet: "Run local SonarQube analysis or inspect issue results",
    promptGuidelines: [
      "Use sonarqube when the user asks to run a local SonarQube scan, inspect issues, or open an issue's source location.",
      "Use the optional severity, status, type, and rule filters to fetch only the most relevant issues.",
    ],
    parameters: SonarToolParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const filters = normalizeIssueFilters({
          severities: params.severities,
          statuses: params.statuses,
          types: params.types,
          rules: params.rules,
        });

        if (params.action === "analyze") {
          const state = await analyzeProject(pi, ctx, params.path, filters);
          rememberState(state);
          return { content: [{ type: "text", text: formatReport(state) }], details: state };
        }

        if (params.action === "metrics") {
          const config = await resolveConfig(ctx, params.path);
          const [measures, issueCounts] = await Promise.all([
            fetchDuplicationMeasures(config.serverUrl, config.token, config.projectKey, ctx.signal),
            fetchIssueSeverityCounts(config.serverUrl, config.token, config.projectKey, ctx.signal),
          ]);
          if (!measures && !issueCounts) {
            return {
              content: [{ type: "text", text: `Project "${config.projectKey}" has not been analyzed yet. Run /sonarqube analyze first.` }],
              details: { error: `Project "${config.projectKey}" has not been analyzed yet. Run /sonarqube analyze first.` },
            };
          }
          const text = formatMetricsOutput({ projectKey: config.projectKey, measures, issueCounts });
          return { content: [{ type: "text", text }], details: { projectKey: config.projectKey, measures, issueCounts } };
        }

        const targetState = await resolveTargetState(ctx, statesByBaseDir, params.path, filters);
        if (!targetState) {
          return {
            content: [{ type: "text", text: "No SonarQube analysis has been run for this target yet." }],
            details: { error: "No SonarQube analysis has been run for this target yet." },
          };
        }

        rememberState(targetState);

        if (params.action === "issues") {
          return { content: [{ type: "text", text: formatReport(targetState) }], details: targetState };
        }

        const index = params.issueIndex ?? 1;
        const issue = targetState.issues[index - 1];
        if (!issue) {
          return {
            content: [{ type: "text", text: `Issue #${index} was not found.` }],
            details: { error: `Issue #${index} was not found.` },
          };
        }

        const preview = await buildIssuePreview(targetState.baseDir, issue);
        return {
          content: [{ type: "text", text: `${formatIssue(issue, index)}\n\n${preview}` }],
          details: { ...targetState, selectedIssue: issue },
        };
      } catch (error) {
        const msg = sonarErrorMessage(error);
        return { content: [{ type: "text", text: msg }], details: { error: msg } };
      }
    },

    renderCall(args, theme, _context) {
      const filters = normalizeIssueFilters({
        severities: args.severities,
        statuses: args.statuses,
        types: args.types,
        rules: args.rules,
      });
      const filterText = filters ? ` ${theme.fg("muted", issueFilterLabel(filters))}` : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("sonarqube"))} ${theme.fg("muted", args.action)}${
          args.path ? ` ${theme.fg("accent", args.path)}` : ""
        }${filterText}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, _context) {
      const state = result.details as
        | SonarAnalysisState
        | { error?: string; selectedIssue?: SonarIssue }
        | undefined;

      if (!state) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      if ("error" in state && state.error) {
        return renderErrorResult(state.error, theme);
      }

      if ("selectedIssue" in state && state.selectedIssue) {
        const issue = state.selectedIssue;
        const contentText = result.content[0]?.type === "text" ? result.content[0].text : undefined;
        return renderIssueResult(issue, contentText, expanded, theme);
      }

      if ("issues" in state) {
        return renderIssueListResult(state, expanded, theme);
      }

      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "", 0, 0);
    },
  });

  pi.registerCommand("sonarqube", {
    description: "Run a local SonarQube analysis, browse the latest issues, or init project config",
    getArgumentCompletions: (argumentPrefix) => sonarArgumentCompletions(argumentPrefix, latestState?.issues),
    handler: async (args, ctx) => {
      try {
        const parsed = parseCommandArgs(args);
        switch (parsed.action) {
          case "help":
            if (ctx.hasUI) ctx.ui.notify(helpText(), "info");
            return;
          case "init":
            await initCommandHandler(ctx, { alias: parsed.alias, targetInput: parsed.targetInput });
            return;
          case "analyze": {
            await commandAnalyze(pi, ctx, parsed.targetInput, parsed.filters, rememberState);
            return;
          }
          case "metrics":
            await commandMetrics(ctx, parsed.targetInput);
            return;
          default:
            await commandIssuesOrOpen(pi, ctx, statesByBaseDir, parsed, rememberState);
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

async function commandAnalyze(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  targetInput: string | undefined,
  filters: SonarIssueFetchOptions | undefined,
  rememberState: (s: SonarAnalysisState) => void,
): Promise<void> {
  const state = await analyzeProject(pi, ctx, targetInput, filters);
  rememberState(state);
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
  targetInput?: string,
): Promise<void> {
  const config = await resolveConfig(ctx, targetInput);
  const [measures, issueCounts] = await Promise.all([
    fetchDuplicationMeasures(config.serverUrl, config.token, config.projectKey, ctx.signal),
    fetchIssueSeverityCounts(config.serverUrl, config.token, config.projectKey, ctx.signal),
  ]);
  if (!measures && !issueCounts) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Project "${config.projectKey}" has not been analyzed yet. Run /sonarqube analyze first.`, "warning");
    }
    return;
  }
  const text = formatMetricsOutput({ projectKey: config.projectKey, measures, issueCounts });
  if (ctx.hasUI) {
    ctx.ui.notify(text, "info");
  }
}

async function commandIssuesOrOpen(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  statesByBaseDir: Map<string, SonarAnalysisState>,
  parsed: { targetInput?: string; filters?: SonarIssueFetchOptions; action: string; issueIndex?: number },
  rememberState: (s: SonarAnalysisState) => void,
): Promise<void> {
  const targetState = await resolveTargetState(ctx, statesByBaseDir, parsed.targetInput, parsed.filters);
  if (!targetState) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `No SonarQube analysis found for this target. Run /sonarqube analyze${targetLabel(parsed.targetInput)} first.`,
        "warning",
      );
    }
    return;
  }
  rememberState(targetState);

  if (parsed.action === "issues") {
    await commandShowIssues(ctx, targetState);
    return;
  }

  // "open"
  const index = parsed.issueIndex ?? 1;
  const issue = targetState.issues[index - 1];
  if (!issue) {
    if (ctx.hasUI) ctx.ui.notify(`Issue #${index} was not found.`, "error");
    return;
  }
  await openIssuePreview(ctx, targetState, issue);
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
    if (issue) await openIssuePreview(ctx, targetState, issue);
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
} from "./types.js";

export { projectConfigPath, loadProjectConfig, saveProjectConfig } from "./config.js";
