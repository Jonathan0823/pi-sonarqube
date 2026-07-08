import type {
  AutocompleteItem,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type {
  SonarIssue,
  SonarIssueFetchOptions,
  SonarDuplicationMeasures,
  IssueSeverityCounts,
  IssueQualityCounts,
  FileDuplication,
  DuplicationBlockGroup,
} from "./types.js";
import {
  SONAR_SEVERITIES,
  SONAR_STATUSES,
  SONAR_TYPES,
  SONAR_SOFTWARE_QUALITIES,
  SONAR_IMPACT_SEVERITIES,
} from "./types.js";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { looksLikePath } from "./config.js";
import { parseSonarIssueArgs, issueFilterLabel } from "./api.js";

// ── Constants ───────────────────────────────────────────────────────────────

export const STATE_TYPE = "sonarqube-analysis-state";

const SONAR_COMMANDS = [
  {
    value: "analyze",
    label: "analyze",
    description: "run analysis and fetch issues",
  },
  { value: "issues", label: "issues", description: "browse the latest issues" },
  { value: "open", label: "open", description: "preview a specific issue" },
  { value: "init", label: "init", description: "configure a project target" },
  {
    value: "metrics",
    label: "metrics",
    description: "show project metrics (duplication, issue counts)",
  },
  {
    value: "duplications",
    label: "duplications",
    description: "browse duplicated files and blocks",
  },
] as const;

// ── Autocomplete helpers ────────────────────────────────────────────────────

export function filterAutocompleteItems(
  items: readonly { value: string; label: string; description?: string }[],
  prefix: string,
): AutocompleteItem[] {
  const query = prefix.trim().toLowerCase();
  if (!query)
    return items.map((item) => ({
      value: item.value,
      label: item.label,
      description: item.description,
    }));
  return items
    .filter(
      (item) =>
        item.value.toLowerCase().startsWith(query) ||
        item.label.toLowerCase().startsWith(query),
    )
    .map((item) => ({
      value: item.value,
      label: item.label,
      description: item.description,
    }));
}

export function mergeAutocompleteSuggestions(
  prefix: string,
  current: AutocompleteSuggestions | null,
  extraItems: AutocompleteItem[],
): AutocompleteSuggestions | null {
  const merged = new Map<string, AutocompleteItem>();
  for (const item of current?.items ?? []) merged.set(item.value, item);
  for (const item of extraItems) merged.set(item.value, item);
  const items = [...merged.values()];
  return items.length > 0 ? { prefix, items } : current;
}

export function splitSonarArgumentContext(argumentText: string): {
  command: string;
  current: string;
  tokens: string[];
} {
  const trimmedLeft = argumentText.replace(/^\s+/, "");
  if (!trimmedLeft) return { command: "", current: "", tokens: [] };

  const tokens = trimmedLeft.split(/\s+/);
  const current = /\s$/.test(argumentText) ? "" : (tokens.pop() ?? "");
  const command = tokens[0] ?? current;
  let tokensOut: string[];
  if (tokens.length > 0) {
    tokensOut = tokens;
  } else if (current) {
    tokensOut = [current];
  } else {
    tokensOut = [];
  }
  return {
    command,
    current,
    tokens: tokensOut,
  };
}

function createFilterCompletionList(
  mode?: "STANDARD" | "MQR",
): AutocompleteItem[] {
  const buildItems = (
    groups: ReadonlyArray<
      readonly [string, readonly string[], string, boolean]
    >,
  ): AutocompleteItem[] =>
    groups.flatMap(([prefix, values, description, includeBare]) =>
      values.flatMap((value) => [
        {
          value: `${prefix}:${value}`,
          label: `${prefix}:${value}`,
          description,
        },
        ...(includeBare ? [{ value, label: value, description }] : []),
      ]),
    );

  const legacyGroups = [
    ["severity", SONAR_SEVERITIES, "severity", true],
    ["status", SONAR_STATUSES, "status", true],
    ["type", SONAR_TYPES, "type", true],
  ] as const;
  const mqrGroups = [
    ["quality", SONAR_SOFTWARE_QUALITIES, "software quality (MQR)", true],
    ["impactSeverity", SONAR_IMPACT_SEVERITIES, "impact severity (MQR)", false],
  ] as const;
  const ruleItems = [
    { value: "rule:", label: "rule:", description: "rule key" },
    { value: "rules:", label: "rules:", description: "rule key" },
  ];
  const scopeItems = [
    { value: "in:", label: "in:", description: "path or dir scope (e.g. in:src/api.ts or in:src/)" },
  ];

  return mode === "MQR"
    ? [...scopeItems, ...ruleItems, ...buildItems(mqrGroups), ...buildItems(legacyGroups)]
    : [...scopeItems, ...ruleItems, ...buildItems(legacyGroups), ...buildItems(mqrGroups)];
}

function listDirCompletions(dirPath: string, baseDir: string): AutocompleteItem[] | null {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const items: AutocompleteItem[] = [];
    const relativePrefix =
      dirPath === baseDir ? "" : relative(baseDir, dirPath) + "/";

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const suffix = entry.isDirectory() ? "/" : "";
      items.push({
        value: `in:${relativePrefix}${entry.name}${suffix}`,
        label: `in:${relativePrefix}${entry.name}${suffix}`,
        description: entry.isDirectory() ? "directory" : "file",
      });
    }

    items.sort((a, b) => {
      const aDir = a.description === "directory" ? 0 : 1;
      const bDir = b.description === "directory" ? 0 : 1;
      return aDir - bDir || a.label.localeCompare(b.label);
    });

    return items.length > 0 ? items.slice(0, 50) : null;
  } catch {
    return null;
  }
}

function fuzzyWithCmd(
  cmd: string,
  args: string[],
  prefix: string,
  baseDir: string,
): AutocompleteItem[] | null {
  const out = execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
  });
  const lines = out.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  const lowerPrefix = prefix.toLowerCase();
  const matched: AutocompleteItem[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (matched.length >= 50) break;
    // Normalize: fd outputs dirs with trailing /, rg doesn't
    const isDir = line.endsWith("/");
    const entry = isDir ? line.slice(0, -1) : line;
    if (!entry.toLowerCase().includes(lowerPrefix)) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);

    matched.push({
      value: `in:${line}`,
      label: `in:${line}`,
      description: isDir ? "directory" : "file",
    });

    // For rg (no dirs output), extract ancestor dirs that match
    if (!isDir) {
      const segs = entry.split("/");
      for (let i = 0; i < segs.length - 1; i++) {
        if (matched.length >= 50) break;
        const dirPath = segs.slice(0, i + 1).join("/") + "/";
        if (seen.has(dirPath)) continue;
        seen.add(dirPath);
        if (segs[i].toLowerCase().includes(lowerPrefix)) {
          matched.push({
            value: `in:${dirPath}`,
            label: `in:${dirPath}`,
            description: "directory",
          });
        }
      }
    }
  }

  matched.sort((a, b) => {
    const aDir = a.description === "directory" ? 0 : 1;
    const bDir = b.description === "directory" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.label.localeCompare(b.label);
  });

  return matched;
}

function getInPathCompletions(prefix: string, baseDir: string): AutocompleteItem[] | null {
  // Directory browsing: show contents when prefix ends with /
  if (prefix.endsWith("/")) {
    return listDirCompletions(resolve(baseDir, prefix), baseDir);
  }

  // Empty prefix: show root directory contents
  if (!prefix) {
    return listDirCompletions(baseDir, baseDir);
  }

  // Try fd first (fast, respects .gitignore, matches Pi TUI behavior)
  try {
    return fuzzyWithCmd(
      "fd",
      [
        "--base-directory",
        baseDir,
        "--type",
        "f",
        "--type",
        "d",
        "--hidden",
        "--exclude",
        ".git",
        "--max-results",
        "50",
        "--full-path",
        prefix,
      ],
      prefix,
      baseDir,
    );
  } catch {
    // fd not available
  }

  // Fallback: rg --files (slower but available on most systems)
  try {
    return fuzzyWithCmd(
      "rg",
      ["--files", "--color", "never", "--no-ignore-parent"],
      prefix,
      baseDir,
    );
  } catch {
    // rg not available
  }

  // Last resort: list current directory
  return listDirCompletions(baseDir, baseDir);
}

export function sonarArgumentCompletions(
  argumentText: string,
  issues?: SonarIssue[],
  mode?: "STANDARD" | "MQR",
  cwd?: string,
): AutocompleteItem[] | null {
  const { command, current, tokens } = splitSonarArgumentContext(argumentText);
  const lowerCommand = command.toLowerCase();
  const commandMatches = SONAR_COMMANDS.filter((item) =>
    item.value.startsWith(lowerCommand),
  );
  const isFullMatch = SONAR_COMMANDS.some(
    (item) => item.value === lowerCommand,
  );

  if (!command || commandMatches.length > 1 || !isFullMatch) {
    if (commandMatches.length === 0) return null;
    return commandMatches.map((item) => ({
      value: item.value,
      label: item.value,
      description: item.description,
    }));
  }

  if (lowerCommand === "open") {
    const issueItems = (issues ?? []).slice(0, 10).map((issue, index) => {
      const lineSuffix = issue.line ? `:${issue.line}` : "";
      return {
        value: String(index + 1),
        label: String(index + 1),
        description: `${issue.severity} ${issue.filePath}${lineSuffix}`,
      };
    });
    const suggestions = [...issueItems, ...createFilterCompletionList(mode)];
    const filtered = filterAutocompleteItems(suggestions, current);
    return filtered.length > 0 ? filtered : null;
  }

  if (lowerCommand === "analyze" || lowerCommand === "issues") {
    if (current.startsWith("in:") && cwd) {
      return getInPathCompletions(current.slice(3), cwd);
    }
    const suggestions = createFilterCompletionList(mode);
    const filtered = filterAutocompleteItems(suggestions, current);
    return filtered.length > 0 ? filtered : null;
  }

  if (
    lowerCommand === "init" ||
    lowerCommand === "metrics" ||
    lowerCommand === "duplications"
  ) {
    return null;
  }

  return tokens.length === 0
    ? filterAutocompleteItems(SONAR_COMMANDS, current)
    : null;
}

// ── Command arg parsing ─────────────────────────────────────────────────────

export type ParsedSonarCommand =
  | { action: "help" }
  | { action: "init"; alias?: string; targetInput?: string }
  | {
      action: "analyze";
      targetInput?: string;
      filters?: SonarIssueFetchOptions;
    }
  | { action: "issues"; targetInput?: string; filters?: SonarIssueFetchOptions }
  | {
      action: "open";
      targetInput?: string;
      issueIndex?: number;
      filters?: SonarIssueFetchOptions;
    }
  | { action: "metrics"; targetInput?: string }
  | { action: "duplications"; targetInput?: string; issueIndex?: number };

export function parseCommandArgs(args: string): ParsedSonarCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { action: "help" };

  const head = tokens[0].toLowerCase();
  if (head === "init") {
    if (tokens.length === 1) return { action: "init" };
    if (tokens.length === 2) {
      return looksLikePath(tokens[1])
        ? { action: "init", targetInput: tokens[1] }
        : { action: "init", alias: tokens[1] };
    }
    return { action: "init", alias: tokens[1], targetInput: tokens[2] };
  }
  if (head === "issues" || head === "view") {
    return { action: "issues", ...parseSonarIssueArgs(tokens.slice(1)) };
  }
  if (head === "open") {
    return { action: "open", ...parseSonarIssueArgs(tokens.slice(1), true) };
  }
  if (head === "analyze" || head === "run") {
    return { action: "analyze", ...parseSonarIssueArgs(tokens.slice(1)) };
  }
  if (head === "metrics") {
    return { action: "metrics", ...parseSonarIssueArgs(tokens.slice(1)) };
  }
  if (head === "duplications") {
    return {
      action: "duplications",
      ...parseSonarIssueArgs(tokens.slice(1), true),
    };
  }

  return { action: "analyze", ...parseSonarIssueArgs(tokens) };
}

// ── Help text / messages ────────────────────────────────────────────────────

export function helpText(): string {
  return [
    "SonarQube commands:",
    "",
    "  /sonarqube init [alias] [path]   configure a project target",
    "  /sonarqube analyze [target]      run analysis for a target or path",
    "  /sonarqube issues [target]       browse issues for a target or path",
    "  /sonarqube open [target] <n>     preview issue #n for a target or path",
    "  /sonarqube metrics [target]      show project metrics (no scanner)",
    "  /sonarqube duplications [target] browse duplicated files and blocks",
    "  /sonarqube                       show this help",
    "",
    "Filters:",
    "  /sonarqube issues be CRITICAL",
    "  /sonarqube issues be severity:CRITICAL status:OPEN",
    "  /sonarqube issues be rule:S1192",
    "  /sonarqube issues in:src/api.ts",
    "  /sonarqube issues in:src/",
    "  /sonarqube issues be quality:RELIABILITY",
    "  /sonarqube issues be quality:SECURITY impactSeverity:HIGH",
    "",
    "Autocomplete:",
    "  type /sonarqube and press Tab to complete the subcommand or filters",
    "",
    "Notes:",
    "  Legacy filters (severity, type) and MQR filters (quality, impactSeverity)",
    "  cannot be combined in the same command. Use one filter family per query.",
    "",
    "Defaults:",
    "  config is stored in .pi/sonarqube.json",
    "  use project paths directly (no alias needed)",
    "  issue and duplication browsers search file, rule, severity, status, message, and stats",
  ].join("\n");
}

export function targetLabel(targetInput?: string): string {
  return targetInput ? ` ${targetInput}` : "";
}

export function sonarErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Issue formatting ────────────────────────────────────────────────────────

export function formatIssue(issue: SonarIssue, index?: number): string {
  const loc = issue.line ? `${issue.filePath}:${issue.line}` : issue.filePath;
  const prefix =
    typeof index === "number" ? `${String(index).padStart(2, "0")}. ` : "";
  const rule = issue.ruleName
    ? `${issue.rule} (${issue.ruleName})`
    : issue.rule;
  return `${prefix}${issue.severity} ${loc} — ${rule} — ${issue.message}`;
}

export function formatMetricsOutput(metrics: {
  projectKey: string;
  measures?: SonarDuplicationMeasures;
  issueCounts?: IssueSeverityCounts;
  issueQualityCounts?: IssueQualityCounts;
  cleanCodeMode?: "STANDARD" | "MQR";
}): string {
  const lines: string[] = [`Metrics for ${metrics.projectKey}`];

  if (metrics.measures) {
    if (metrics.measures.coverage === undefined) {
      lines.push("Coverage: n/a");
    } else {
      const pct = metrics.measures.coverage.toFixed(1);
      const covered =
        (metrics.measures.linesToCover ?? 0) -
        (metrics.measures.uncoveredLines ?? 0);
      const uncovered = metrics.measures.uncoveredLines ?? 0;
      const total = metrics.measures.linesToCover ?? 0;
      lines.push(
        `Coverage: ${pct}%  covered=${covered}  uncovered=${uncovered}  lines=${total}`,
      );
    }

    const density = metrics.measures.duplicatedLinesDensity.toFixed(1);
    lines.push(
      metrics.measures.duplicatedBlocks > 0
        ? `Duplication: ${density}%  lines=${metrics.measures.duplicatedLines}  blocks=${metrics.measures.duplicatedBlocks}  files=${metrics.measures.duplicatedFiles}`
        : `Duplication: ${density}%  (no duplications detected)`,
    );
  }

  if (metrics.issueCounts) {
    const counts =
      metrics.cleanCodeMode === "MQR"
        ? [
            `BLOCKER ${metrics.issueCounts.blocker}`,
            `HIGH ${metrics.issueCounts.critical}`,
            `MEDIUM ${metrics.issueCounts.major}`,
            `LOW ${metrics.issueCounts.minor}`,
            `INFO ${metrics.issueCounts.info}`,
          ]
        : [
            `BLOCKER ${metrics.issueCounts.blocker}`,
            `CRITICAL ${metrics.issueCounts.critical}`,
            `MAJOR ${metrics.issueCounts.major}`,
            `MINOR ${metrics.issueCounts.minor}`,
            `INFO ${metrics.issueCounts.info}`,
          ];
    lines.push(`Issues:  ${counts.join("  ")}`);
  }

  if (metrics.issueQualityCounts) {
    const counts = [
      `MAINTAINABILITY ${metrics.issueQualityCounts.maintainability}`,
      `RELIABILITY ${metrics.issueQualityCounts.reliability}`,
      `SECURITY ${metrics.issueQualityCounts.security}`,
    ];
    lines.push(`Quality: ${counts.join("  ")}`);
  }

  return lines.join("\n");
}

export function formatDuplicationsList(files: FileDuplication[]): string {
  if (files.length === 0) return "No duplicated files found.";
  const lines: string[] = [`Duplicated files (${files.length})`];
  for (const [i, f] of files.entries()) {
    lines.push(
      `  ${String(i + 1).padStart(2, " ")}. ${f.filePath}  dup%=${f.duplicatedLinesDensity.toFixed(1)}  blocks=${f.duplicatedBlocks}  lines=${f.duplicatedLines}`,
    );
  }
  return lines.join("\n");
}

export function formatDuplicationBlockDetail(
  filePath: string,
  groups: DuplicationBlockGroup[],
): string {
  if (groups.length === 0) return `No duplications found in ${filePath}.`;
  const lines: string[] = [`Duplications in ${filePath}`, ""];
  for (const [i, group] of groups.entries()) {
    lines.push(`Block ${i + 1}:`);
    for (const block of group.blocks) {
      const end = block.from + block.size - 1;
      lines.push(`  ${block.filePath}:${block.from}-${end}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function formatSummary(state: {
  totalIssues: number;
  projectKey: string;
  filters?: SonarIssueFetchOptions;
}): string {
  const issueCount = state.totalIssues;
  const filterLabel = state.filters
    ? ` (${issueFilterLabel(state.filters)})`
    : "";
  if (issueCount === 0) {
    return `SonarQube: no issues found for ${state.projectKey}${filterLabel}`;
  }
  const plural = issueCount === 1 ? "" : "s";
  return `SonarQube: ${issueCount} issue${plural} found for ${state.projectKey}${filterLabel}`;
}

export function formatReport(state: {
  projectKey: string;
  serverUrl: string;
  baseDir: string;
  totalIssues: number;
  filters?: SonarIssueFetchOptions;
  measures?: SonarDuplicationMeasures;
  issues: SonarIssue[];
}): string {
  const lines = [
    `Project: ${state.projectKey}`,
    `Server: ${state.serverUrl}`,
    `Base dir: ${state.baseDir}`,
    `Issues: ${state.totalIssues}`,
  ];

  if (state.filters) {
    lines.push(`Filters: ${issueFilterLabel(state.filters)}`);
  }

  if (state.measures && state.issues.length > 0) {
    lines.push(
      "",
      state.measures.duplicatedBlocks > 0
        ? `Duplication: ${state.measures.duplicatedLinesDensity.toFixed(1)}%  lines=${state.measures.duplicatedLines}  blocks=${state.measures.duplicatedBlocks}  files=${state.measures.duplicatedFiles}`
        : `Duplication: ${state.measures.duplicatedLinesDensity.toFixed(1)}%  (no duplications detected)`,
    );
  }

  if (state.issues.length === 0) {
    if (!state.measures) lines.push("No open issues found.");
    return lines.join("\n");
  }

  lines.push("");
  for (const [i, issue] of state.issues.slice(0, 10).entries()) {
    lines.push(formatIssue(issue, i + 1));
  }
  if (state.issues.length > 10) {
    lines.push(`... ${state.issues.length - 10} more`);
  }
  return lines.join("\n");
}
