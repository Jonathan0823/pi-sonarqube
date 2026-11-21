import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  CommandRunner,
  FileDuplication,
  SessionStateStore,
  SonarAnalysisState,
  SonarIssueFetchOptions,
  SonarProjectConfig,
} from "./types.js";
import {
  runScanner,
  readReportTask,
  waitForAnalysis,
  normalizeIssueFilters,
  normalizeIssueList,
  fetchIssues,
  fetchDuplicationMeasures,
  fetchIssueSeverityCounts,
  fetchIssueQualityCounts,
  fetchFileDuplications,
  fetchFileDuplicationBlocks,
  createAnalysisState,
  fetchCleanCodeMode,
  fetchJson,
  assertFiltersNotAmbiguous,
} from "./api.js";
import {
  loadProjectConfig,
  looksLikePath,
  resolveConfig,
  resolveTarget,
} from "./config.js";
import {
  assertIssueSelection,
  formatDuplicationsList,
  formatIssue,
  formatMetricsOutput,
  formatReport,
  sonarErrorMessage,
} from "./commands.js";
import {
  buildDuplicationPreview,
  buildIssueKeyPreviews,
  buildIssuePreview,
  resolveTargetState,
} from "./previews.js";

/** An action request: the tool parameter shape, plus two command-only fields. */
export interface SonarActionRequest extends SonarIssueFetchOptions {
  action: "analyze" | "issues" | "open" | "metrics" | "duplications";
  /** Configured target alias or project root directory. */
  path?: string;
  issueIndex?: number;
  /** duplications: return the preview of the Nth duplicated file (1-based). */
  fileIndex?: number;
  /** duplications: return the list of duplicated files instead of previews. */
  view?: "list";
}

/** Progress reporting for long-running analysis, supplied by the host. */
export interface AnalysisProgress {
  setPhase(phase: string): void;
  stop(): void;
}

/** Everything host-specific the core needs, supplied by the adapter. */
export interface SonarCoreEnv {
  cwd: string;
  signal?: AbortSignal;
  /** Host's per-project config directory name (e.g. ".pi"). */
  configDirName: string;
  exec: CommandRunner;
  store: SessionStateStore;
  /** Called once the analysis target is resolved and about to be scanned. */
  startProgress?: (config: SonarProjectConfig) => AnalysisProgress;
}

/**
 * Outcome of an action. `blocks`, when present, is `text` split into the
 * separate text blocks a host may want to present individually. Expected
 * non-error outcomes that the user should see (nothing analyzed yet, nothing
 * found, ...) have `details.error` and `details.code` set; real failures throw.
 */
export interface SonarActionResult {
  text: string;
  blocks?: string[];
  details: object;
}

function soft(
  text: string,
  code: string,
  error = text,
  extra: object = {},
): SonarActionResult {
  return { text, details: { error, code, ...extra } };
}

export async function runSonarAction(
  request: SonarActionRequest,
  env: SonarCoreEnv,
): Promise<SonarActionResult> {
  const filters = normalizeIssueFilters({
    severities: request.severities,
    statuses: request.statuses,
    types: request.types,
    rules: request.rules,
    softwareQualities: request.softwareQualities,
    impactSeverities: request.impactSeverities,
    pathScope: request.pathScope,
  });
  assertFiltersNotAmbiguous(filters);
  const issueKeys = normalizeIssueList(request.issueKeys);
  assertIssueSelection(request.issueIndex, issueKeys);
  if (issueKeys?.length && request.action !== "open") {
    throw new Error("issueKeys can only be used with the open action.");
  }
  if (request.action !== "metrics" && request.action !== "duplications") {
    await assertPathIsProjectRoot(env, request.path);
  }

  switch (request.action) {
    case "analyze": {
      const state = await analyzeProject(env, request.path, filters);
      env.store.remember(state);
      return { text: formatReport(state), details: state };
    }
    case "duplications":
      return duplications(env, request);
    case "metrics":
      return metrics(env, request.path);
    default:
      return issuesOrOpen(env, request, filters, issueKeys);
  }
}

async function isProjectRoot(dir: string, configDirName: string) {
  const hasProperties = await stat(`${dir}/sonar-project.properties`).catch(
    () => undefined,
  );
  return (
    Boolean(hasProperties) ||
    Boolean(await loadProjectConfig(dir, configDirName))
  );
}

/** `path` selects a project; a source file or subdirectory belongs in `pathScope`. */
async function assertPathIsProjectRoot(
  env: SonarCoreEnv,
  path: string | undefined,
): Promise<void> {
  if (!path) return;
  const misuse = new Error(
    `"${path}" is a source path, not a SonarQube target. Pass a configured target alias or project root as \`path\` and use \`pathScope\` for files or directories inside it.`,
  );
  if (looksLikePath(path)) {
    const info = await stat(resolve(env.cwd, path)).catch(() => undefined);
    if (info?.isFile()) throw misuse;
  }
  const { baseDir, repoRoot, alias } = await resolveTarget(env, path);
  if (alias || (await isProjectRoot(baseDir, env.configDirName))) return;
  for (
    let dir = dirname(baseDir);
    dir.startsWith(repoRoot);
    dir = dirname(dir)
  ) {
    if (await isProjectRoot(dir, env.configDirName)) throw misuse;
    if (dir === repoRoot || dir === dirname(dir)) break;
  }
}

async function analyzeProject(
  env: SonarCoreEnv,
  inputPath?: string,
  filters?: SonarIssueFetchOptions,
): Promise<SonarAnalysisState> {
  const config = await resolveConfig(env, inputPath);
  const baseDirStat = await stat(config.baseDir).catch(() => undefined);
  if (!baseDirStat?.isDirectory()) {
    throw new Error(`Project directory not found: ${config.baseDir}`);
  }

  const progress = env.startProgress?.(config);

  try {
    progress?.setPhase("Running sonar-scanner...");
    await runScanner(env.exec, config, env.signal);

    progress?.setPhase("Reading scanner report...");
    const report = await readReportTask(config.baseDir);
    const ceTaskUrl = report["ceTaskUrl"];
    const dashboardUrl = report["dashboardUrl"];
    const analysisId = ceTaskUrl
      ? (progress?.setPhase("Waiting for SonarQube analysis..."),
        await waitForAnalysis(
          config.serverUrl,
          config.token,
          ceTaskUrl,
          env.signal,
        ))
      : undefined;

    progress?.setPhase("Fetching issues...");
    const normalizedFilters = normalizeIssueFilters(filters);
    const issues = await fetchIssues(
      config.serverUrl,
      config.token,
      config.projectKey,
      env.signal,
      normalizedFilters,
      config.baseDir,
    );

    progress?.setPhase("Fetching metrics...");
    const measures = await fetchDuplicationMeasures(
      config.serverUrl,
      config.token,
      config.projectKey,
      env.signal,
    );

    progress?.setPhase("Detecting mode...");
    const cleanCodeMode = await fetchCleanCodeMode(
      config.serverUrl,
      config.token,
      env.signal,
    );

    const state = createAnalysisState(config, issues, {
      dashboardUrl,
      ceTaskUrl,
      analysisId,
      filters: normalizedFilters,
      measures,
      cleanCodeMode,
    });

    env.store.persist(state);
    return state;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    progress?.stop();
  }
}

async function issuesOrOpen(
  env: SonarCoreEnv,
  request: SonarActionRequest,
  filters: SonarIssueFetchOptions | undefined,
  issueKeys: string[] | undefined,
): Promise<SonarActionResult> {
  const targetState = await resolveTargetState(
    env,
    env.store,
    request.path,
    normalizeIssueFilters({ ...filters, issueKeys }),
  );
  if (!targetState) {
    return soft(
      "No SonarQube analysis has been run for this target yet.",
      "no_analysis",
    );
  }

  env.store.remember(targetState);

  if (request.action === "issues") {
    return { text: formatReport(targetState), details: targetState };
  }

  if (issueKeys?.length) {
    const result = await buildIssueKeyPreviews(
      targetState.baseDir,
      issueKeys,
      targetState.issues,
    );
    return { text: result.text, details: result };
  }

  const index = request.issueIndex ?? 1;
  const issue = targetState.issues[index - 1];
  if (!issue) {
    return soft(`Issue #${index} was not found.`, "issue_not_found");
  }

  const preview = await buildIssuePreview(targetState.baseDir, issue);
  return {
    text: `${formatIssue(issue, index)}\n\n${preview}`,
    details: { ...targetState, selectedIssue: issue },
  };
}

async function loadMetricsData(
  config: SonarProjectConfig,
  signal?: AbortSignal,
) {
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

async function resolveConfigOrSoft(
  env: SonarCoreEnv,
  path: string | undefined,
): Promise<SonarProjectConfig | SonarActionResult> {
  try {
    return await resolveConfig(env, path);
  } catch (cause) {
    return soft(
      "Project not configured. Run /sonarqube init first.",
      "not_configured",
      "Project not configured.",
      { cause },
    );
  }
}

/** Distinguishes an unreachable server or rejected token from "not analyzed". */
async function assertServerResponds(config: SonarProjectConfig): Promise<void> {
  try {
    await fetchJson(
      `${config.serverUrl}/api/measures/component?component=${encodeURIComponent(config.projectKey)}&metricKeys=coverage`,
      config.token,
    );
  } catch (error) {
    const message = sonarErrorMessage(error);
    if (message.includes("(404 ")) return;
    if (message.includes("(401 ") || message.includes("(403 ")) {
      throw new Error(
        `SonarQube authentication failed at ${config.serverUrl}. Check the token. ${message}`,
      );
    }
    if (message.includes("SonarQube API request failed")) throw error;
    throw new Error(
      `Cannot reach SonarQube at ${config.serverUrl}: ${message}`,
    );
  }
}

async function metrics(
  env: SonarCoreEnv,
  path: string | undefined,
): Promise<SonarActionResult> {
  const config = await resolveConfigOrSoft(env, path);
  if ("text" in config) return config;
  const data = await loadMetricsData(config, env.signal);
  if (!data) {
    await assertServerResponds(config);
    return soft(
      `Project "${config.projectKey}" has not been analyzed yet. Run /sonarqube analyze first.`,
      "not_analyzed",
    );
  }
  const text = formatMetricsOutput({
    projectKey: config.projectKey,
    measures: data.measures,
    issueCounts: data.issueCounts,
    issueQualityCounts: data.qualityCounts,
    cleanCodeMode: data.cleanCodeMode,
  });
  return {
    text,
    details: {
      projectKey: config.projectKey,
      measures: data.measures,
      issueCounts: data.issueCounts,
      issueQualityCounts: data.qualityCounts,
      cleanCodeMode: data.cleanCodeMode,
    },
  };
}

async function duplications(
  env: SonarCoreEnv,
  request: SonarActionRequest,
): Promise<SonarActionResult> {
  const config = await resolveConfigOrSoft(env, request.path);
  if ("text" in config) return config;
  const interactive =
    request.view === "list" || request.fileIndex !== undefined;
  let files: FileDuplication[];
  try {
    files = await fetchFileDuplications(
      config.serverUrl,
      config.token,
      config.projectKey,
      env.signal,
      // Only the interactive views honor pathScope; the summary does not.
      interactive ? request.pathScope : undefined,
      config.baseDir,
    );
  } catch (error) {
    const msg = sonarErrorMessage(error);
    if (msg.includes("403") || msg.includes("Insufficient privileges")) {
      return soft(
        "SonarQube token needs 'See Source Code' permission to list duplicated files. Grant it in SonarQube project permissions, then update the token via /sonarqube init.",
        "forbidden",
        "Token missing 'See Source Code' permission.",
      );
    }
    throw error;
  }
  if (files.length === 0) {
    return soft(
      `No duplications found for ${config.projectKey}.`,
      "no_duplications",
    );
  }

  if (request.view === "list") {
    return {
      text: formatDuplicationsList(files),
      details: { projectKey: config.projectKey, files },
    };
  }

  if (request.fileIndex !== undefined) {
    const file = files[request.fileIndex - 1];
    if (!file) {
      return soft(`File #${request.fileIndex} not found.`, "file_not_found");
    }
    const groups = await fetchFileDuplicationBlocks(
      config.serverUrl,
      config.token,
      file.fileKey,
      config.projectKey,
      env.signal,
    );
    const text = await buildDuplicationPreview(
      config.baseDir,
      file.filePath,
      groups,
    );
    return {
      text,
      details: { projectKey: config.projectKey, filePath: file.filePath },
    };
  }

  const topFiles = files.slice(0, 5);
  const topContexts = await Promise.all(
    topFiles.map(async (file) => {
      const summary = {
        filePath: file.filePath,
        duplicatedBlocks: file.duplicatedBlocks,
        duplicatedLines: file.duplicatedLines,
        duplicatedLinesDensity: file.duplicatedLinesDensity,
      };
      try {
        const groups = await fetchFileDuplicationBlocks(
          config.serverUrl,
          config.token,
          file.fileKey,
          config.projectKey,
          env.signal,
        );
        const preview = await buildDuplicationPreview(
          config.baseDir,
          file.filePath,
          groups,
        );
        return { ...summary, preview };
      } catch (error) {
        return {
          ...summary,
          preview: `Duplications in ${file.filePath}\n\n<failed to load duplicated lines: ${sonarErrorMessage(error)}>`,
        };
      }
    }),
  );
  const remaining = files.length - topContexts.length;
  const blocks = [
    `Duplicated files for ${config.projectKey}: ${files.length}. Showing top ${topContexts.length}.`,
    ...topContexts.map(
      (item, index) =>
        `#${index + 1} ${item.filePath}  dup%=${item.duplicatedLinesDensity.toFixed(1)}  blocks=${item.duplicatedBlocks}  lines=${item.duplicatedLines}\n${item.preview}`,
    ),
    ...(remaining > 0 ? [`+ ${remaining} more file(s) not shown`] : []),
  ];
  return {
    text: blocks.join("\n"),
    blocks,
    details: {
      projectKey: config.projectKey,
      totalFiles: files.length,
      topFiles: topContexts,
      moreFiles: remaining,
    },
  };
}
