import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
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
  FileDuplication,
  SonarProjectConfig,
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
  fetchIssueQualityCounts,
  fetchFileDuplications,
  fetchFileDuplicationBlocks,
  createAnalysisState,
  issueFilterLabel,
  fetchCleanCodeMode,
  assertFiltersNotAmbiguous,
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
  formatDuplicationsList,
  formatReport,
  helpText,
  targetLabel,
  sonarErrorMessage,
} from "./commands.js";

import {
  startAnalysisUi,
  showIssueBrowser,
  buildIssuePreview,
  buildDuplicationPreview,
  openIssuePreview,
  resolveTargetState,
  showDuplicationBrowser,
} from "./ui.js";

const SonarToolParams = Type.Object({
  action: StringEnum([
    "analyze",
    "issues",
    "open",
    "metrics",
    "duplications",
  ] as const),
  path: Type.Optional(
    Type.String({
      description: "Target alias or project directory to analyze or inspect",
    }),
  ),
  issueIndex: Type.Optional(
    Type.Number({ description: "1-based issue index to open" }),
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
        await waitForAnalysis(
          config.serverUrl,
          config.token,
          ceTaskUrl,
          ctx.signal,
        ))
      : undefined;

    analysisUi.setPhase("Fetching issues...");
    const normalizedFilters = normalizeIssueFilters(filters);
    const issues = await fetchIssues(
      config.serverUrl,
      config.token,
      config.projectKey,
      ctx.signal,
      normalizedFilters,
      config.baseDir,
    );

    analysisUi.setPhase("Fetching metrics...");
    const measures = await fetchDuplicationMeasures(
      config.serverUrl,
      config.token,
      config.projectKey,
      ctx.signal,
    );

    analysisUi.setPhase("Detecting mode...");
    const cleanCodeMode = await fetchCleanCodeMode(
      config.serverUrl,
      config.token,
      ctx.signal,
    );

    const state = createAnalysisState(config, issues, {
      dashboardUrl,
      ceTaskUrl,
      analysisId,
      filters: normalizedFilters,
      measures,
      cleanCodeMode,
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
  const { baseDir, repoRoot } = await resolveInitTarget(
    ctx,
    options.alias,
    options.targetInput,
  );
  const existing = await loadProjectConfig(baseDir);

  const confirmed = existing
    ? await confirmOverwrite(ctx, baseDir, existing)
    : true;
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
  ctx.ui.notify(
    `SonarQube config saved${label} to ${projectConfigPath(baseDir)}${note}`,
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
    lines.push(theme.fg("muted", formatIssue(issue, i + 1)));
  }
  if (!expanded && state.issues.length > visible.length) {
    lines.push(
      theme.fg("dim", `... ${state.issues.length - visible.length} more`),
    );
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
          if (!match)
            return current.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              options,
            );

          const argumentText = match[1] ?? "";
          const { current: currentToken } =
            splitSonarArgumentContext(argumentText);
          const extraItems =
            sonarArgumentCompletions(
              argumentText,
              latestState?.issues,
              latestState?.cleanCodeMode,
            ) ?? [];
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
      "Use the optional severity, status, type, rule, quality, and impact severity filters to fetch only the most relevant issues.",
    ],
    parameters: SonarToolParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const filters = normalizeIssueFilters({
          severities: params.severities,
          statuses: params.statuses,
          types: params.types,
          rules: params.rules,
          softwareQualities: params.softwareQualities,
          impactSeverities: params.impactSeverities,
        });
        assertFiltersNotAmbiguous(filters);

        if (params.action === "analyze") {
          const state = await analyzeProject(pi, ctx, params.path, filters);
          rememberState(state);
          return {
            content: [{ type: "text", text: formatReport(state) }],
            details: state,
          };
        }

        if (params.action === "duplications")
          return toolDuplications(ctx, params.path);
        if (params.action === "metrics") return toolMetrics(ctx, params.path);

        const targetState = await resolveTargetState(
          ctx,
          statesByBaseDir,
          params.path,
          filters,
        );
        if (!targetState) {
          return {
            content: [
              {
                type: "text",
                text: "No SonarQube analysis has been run for this target yet.",
              },
            ],
            details: {
              error: "No SonarQube analysis has been run for this target yet.",
            },
          };
        }

        rememberState(targetState);

        if (params.action === "issues") {
          return {
            content: [{ type: "text", text: formatReport(targetState) }],
            details: targetState,
          };
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
          content: [
            {
              type: "text",
              text: `${formatIssue(issue, index)}\n\n${preview}`,
            },
          ],
          details: { ...targetState, selectedIssue: issue },
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
      });
      const filterText = filters
        ? ` ${theme.fg("muted", issueFilterLabel(filters))}`
        : "";
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
        const contentText =
          result.content[0]?.type === "text"
            ? result.content[0].text
            : undefined;
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
    description:
      "Run a local SonarQube analysis, browse the latest issues, or init project config",
    getArgumentCompletions: (argumentPrefix) =>
      sonarArgumentCompletions(
        argumentPrefix,
        latestState?.issues,
        latestState?.cleanCodeMode,
        process.cwd(),
      ),
    handler: async (args, ctx) => {
      try {
        const parsed = parseCommandArgs(args);
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
          case "analyze": {
            await commandAnalyze(
              pi,
              ctx,
              parsed.targetInput,
              parsed.filters,
              rememberState,
            );
            return;
          }
          case "metrics":
            await commandMetrics(ctx, parsed.targetInput);
            return;
          case "duplications":
            await commandDuplications(
              pi,
              ctx,
              parsed.targetInput,
              parsed.issueIndex,
              parsed.filters,
            );
            return;
          default:
            await commandIssuesOrOpen(
              pi,
              ctx,
              statesByBaseDir,
              parsed,
              rememberState,
            );
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

async function loadMetricsData(
  config: SonarProjectConfig,
  signal?: AbortSignal,
): Promise<{
  cleanCodeMode: Awaited<ReturnType<typeof fetchCleanCodeMode>>;
  measures: Awaited<ReturnType<typeof fetchDuplicationMeasures>>;
  issueCounts: Awaited<ReturnType<typeof fetchIssueSeverityCounts>>;
  qualityCounts: Awaited<ReturnType<typeof fetchIssueQualityCounts>>;
} | null> {
  const cleanCodeMode = await fetchCleanCodeMode(
    config.serverUrl,
    config.token,
    signal,
  );
  const [measures, issueCounts, qualityCounts] = await Promise.all([
    fetchDuplicationMeasures(
      config.serverUrl,
      config.token,
      config.projectKey,
      signal,
    ),
    fetchIssueSeverityCounts(
      config.serverUrl,
      config.token,
      config.projectKey,
      signal,
      cleanCodeMode,
    ),
    fetchIssueQualityCounts(
      config.serverUrl,
      config.token,
      config.projectKey,
      signal,
    ),
  ]);
  if (!measures && !issueCounts && !qualityCounts) return null;
  return { cleanCodeMode, measures, issueCounts, qualityCounts };
}

async function commandMetrics(
  ctx: ExtensionCommandContext,
  targetInput?: string,
): Promise<void> {
  const config = await resolveConfig(ctx, targetInput);
  const metrics = await loadMetricsData(config, ctx.signal);
  if (!metrics) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Project "${config.projectKey}" has not been analyzed yet. Run /sonarqube analyze first.`,
        "warning",
      );
    }
    return;
  }
  const text = formatMetricsOutput({
    projectKey: config.projectKey,
    measures: metrics.measures,
    issueCounts: metrics.issueCounts,
    issueQualityCounts: metrics.qualityCounts,
    cleanCodeMode: metrics.cleanCodeMode,
  });
  if (ctx.hasUI) {
    ctx.ui.notify(text, "info");
  }
}

async function commandDuplications(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  targetInput?: string,
  fileIndex?: number,
  filters?: SonarIssueFetchOptions,
): Promise<void> {
  const config = await resolveConfig(ctx, targetInput);
  let files: FileDuplication[];
  try {
    files = await fetchFileDuplications(
      config.serverUrl,
      config.token,
      config.projectKey,
      ctx.signal,
      filters?.pathScope,
      config.baseDir,
    );
  } catch (error) {
    const msg = sonarErrorMessage(error);
    if (msg.includes("403") || msg.includes("Insufficient privileges")) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "SonarQube token needs 'See Source Code' permission to list duplicated files. Update the token permissions in SonarQube and run /sonarqube init to update the token.",
          "warning",
        );
      }
      return;
    }
    throw error;
  }
  if (files.length === 0) {
    if (ctx.hasUI) ctx.ui.notify("No duplications found.", "info");
    return;
  }

  if (fileIndex !== undefined) {
    await showDuplicationDrillDown(ctx, config, files, fileIndex);
    return;
  }
  await showDuplicationListOrBrowser(ctx, config, files);
}

async function showDuplicationDrillDown(
  ctx: ExtensionCommandContext,
  config: SonarProjectConfig,
  files: FileDuplication[],
  fileIndex: number,
): Promise<void> {
  const file = files[fileIndex - 1];
  if (!file) {
    if (ctx.hasUI) ctx.ui.notify(`File #${fileIndex} not found.`, "error");
    return;
  }
  const groups = await fetchFileDuplicationBlocks(
    config.serverUrl,
    config.token,
    file.fileKey,
    config.projectKey,
    ctx.signal,
  );
  const text = await buildDuplicationPreview(
    config.baseDir,
    file.filePath,
    groups,
  );
  if (ctx.mode === "tui") {
    await ctx.ui.editor(`Duplications in ${file.filePath}`, text);
  } else if (ctx.hasUI) {
    ctx.ui.notify(text, "info");
  }
}

async function showDuplicationListOrBrowser(
  ctx: ExtensionCommandContext,
  config: SonarProjectConfig,
  files: FileDuplication[],
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(formatDuplicationsList(files), "info");
    return;
  }
  const choice = await showDuplicationBrowser(ctx, files);
  if (choice == null) return;
  const file = files[choice];
  const groups = await fetchFileDuplicationBlocks(
    config.serverUrl,
    config.token,
    file.fileKey,
    config.projectKey,
    ctx.signal,
  );
  const lines = [`Duplications in ${file.filePath}`];
  for (const [i, group] of groups.entries()) {
    lines.push("", `Block ${i + 1}:`);
    for (const block of group.blocks) {
      const end = block.from + block.size - 1;
      lines.push(`  ${block.filePath}:${block.from}-${end}`);
    }
  }
  ctx.ui.setEditorText(lines.join("\n"));
  ctx.ui.notify("Duplication loaded into editor — press Enter to send", "info");
}

async function commandIssuesOrOpen(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  statesByBaseDir: Map<string, SonarAnalysisState>,
  parsed: {
    targetInput?: string;
    filters?: SonarIssueFetchOptions;
    action: string;
    issueIndex?: number;
  },
  rememberState: (s: SonarAnalysisState) => void,
): Promise<void> {
  const targetState = await resolveTargetState(
    ctx,
    statesByBaseDir,
    parsed.targetInput,
    parsed.filters,
  );
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

// ── Tool helper functions ────────────────────────────────────────────────────

async function toolDuplications(
  ctx: any,
  path: string | undefined,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}> {
  let config;
  try {
    config = await resolveConfig(ctx, path);
  } catch {
    return {
      content: [
        {
          type: "text",
          text: "Project not configured. Run /sonarqube init first.",
        },
      ],
      details: { error: "Project not configured." },
    };
  }
  let files: FileDuplication[];
  try {
    files = await fetchFileDuplications(
      config.serverUrl,
      config.token,
      config.projectKey,
      ctx.signal,
    );
  } catch (error) {
    const msg = sonarErrorMessage(error);
    if (msg.includes("403") || msg.includes("Insufficient privileges")) {
      return {
        content: [
          {
            type: "text",
            text: "SonarQube token needs 'See Source Code' permission to list duplicated files. Grant it in SonarQube project permissions, then update the token via /sonarqube init.",
          },
        ],
        details: { error: "Token missing 'See Source Code' permission." },
      };
    }
    return {
      content: [{ type: "text", text: msg }],
      details: { error: msg },
    };
  }
  if (files.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No duplications found for ${config.projectKey}.`,
        },
      ],
      details: { error: `No duplications found for ${config.projectKey}.` },
    };
  }

  const topFiles = files.slice(0, 5);
  const topContexts = await Promise.all(
    topFiles.map(async (file) => {
      try {
        const groups = await fetchFileDuplicationBlocks(
          config.serverUrl,
          config.token,
          file.fileKey,
          config.projectKey,
          ctx.signal,
        );
        const preview = await buildDuplicationPreview(
          config.baseDir,
          file.filePath,
          groups,
        );
        return {
          filePath: file.filePath,
          duplicatedBlocks: file.duplicatedBlocks,
          duplicatedLines: file.duplicatedLines,
          duplicatedLinesDensity: file.duplicatedLinesDensity,
          preview,
        };
      } catch (error) {
        return {
          filePath: file.filePath,
          duplicatedBlocks: file.duplicatedBlocks,
          duplicatedLines: file.duplicatedLines,
          duplicatedLinesDensity: file.duplicatedLinesDensity,
          preview: `Duplications in ${file.filePath}\n\n<failed to load duplicated lines: ${sonarErrorMessage(error)}>`,
        };
      }
    }),
  );
  const remaining = files.length - topContexts.length;
  const content: Array<{ type: "text"; text: string }> = [
    {
      type: "text",
      text: `Duplicated files for ${config.projectKey}: ${files.length}. Showing top ${topContexts.length}.`,
    },
    ...topContexts.map((item, index) => ({
      type: "text" as const,
      text: `#${index + 1} ${item.filePath}  dup%=${item.duplicatedLinesDensity.toFixed(1)}  blocks=${item.duplicatedBlocks}  lines=${item.duplicatedLines}\n${item.preview}`,
    })),
    ...(remaining > 0
      ? [
          {
            type: "text" as const,
            text: `+ ${remaining} more file(s) not shown`,
          },
        ]
      : []),
  ];
  return {
    content,
    details: {
      projectKey: config.projectKey,
      totalFiles: files.length,
      topFiles: topContexts,
      moreFiles: remaining,
    },
  };
}

async function toolMetrics(
  ctx: any,
  path: string | undefined,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}> {
  let config;
  try {
    config = await resolveConfig(ctx, path);
  } catch {
    return {
      content: [
        {
          type: "text",
          text: "Project not configured. Run /sonarqube init first.",
        },
      ],
      details: { error: "Project not configured." },
    };
  }
  const metrics = await loadMetricsData(config, ctx.signal);
  if (!metrics) {
    return {
      content: [
        {
          type: "text",
          text: `Project "${config.projectKey}" has not been analyzed yet. Run /sonarqube analyze first.`,
        },
      ],
      details: {
        error: `Project "${config.projectKey}" has not been analyzed yet. Run /sonarqube analyze first.`,
      },
    };
  }
  const text = formatMetricsOutput({
    projectKey: config.projectKey,
    measures: metrics.measures,
    issueCounts: metrics.issueCounts,
    issueQualityCounts: metrics.qualityCounts,
    cleanCodeMode: metrics.cleanCodeMode,
  });
  return {
    content: [{ type: "text", text }],
    details: {
      projectKey: config.projectKey,
      measures: metrics.measures,
      issueCounts: metrics.issueCounts,
      issueQualityCounts: metrics.qualityCounts,
      cleanCodeMode: metrics.cleanCodeMode,
    },
  };
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
} from "./types.js";

export {
  projectConfigPath,
  loadProjectConfig,
  saveProjectConfig,
} from "./config.js";
