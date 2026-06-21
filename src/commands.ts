import type { AutocompleteItem, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type { SonarIssue, SonarIssueFetchOptions, SonarDuplicationMeasures } from "./types.js";
import { SONAR_SEVERITIES, SONAR_STATUSES, SONAR_TYPES } from "./types.js";
import { looksLikePath } from "./config.js";
import { parseSonarIssueArgs, issueFilterLabel } from "./api.js";

// ── Constants ───────────────────────────────────────────────────────────────

export const STATE_TYPE = "sonarqube-analysis-state";

const SONAR_COMMANDS = [
  { value: "analyze", label: "analyze", description: "run analysis and fetch issues" },
  { value: "issues", label: "issues", description: "browse the latest issues" },
  { value: "open", label: "open", description: "preview a specific issue" },
  { value: "init", label: "init", description: "configure a project target" },
] as const;

// ── Autocomplete helpers ────────────────────────────────────────────────────

function createAutocompleteItem(value: string, description?: string): AutocompleteItem {
  return description ? { value, label: value, description } : { value, label: value };
}

export function filterAutocompleteItems(
  items: readonly { value: string; label: string; description?: string }[],
  prefix: string,
): AutocompleteItem[] {
  const query = prefix.trim().toLowerCase();
  if (!query) return items.map((item) => ({ value: item.value, label: item.label, description: item.description }));
  return items
    .filter(
      (item) =>
        item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().startsWith(query),
    )
    .map((item) => ({ value: item.value, label: item.label, description: item.description }));
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

export function splitSonarArgumentContext(
  argumentText: string,
): { command: string; current: string; tokens: string[] } {
  const trimmedLeft = argumentText.replace(/^\s+/, "");
  if (!trimmedLeft) return { command: "", current: "", tokens: [] };

  const tokens = trimmedLeft.split(/\s+/);
  const current = /\s$/.test(argumentText) ? "" : tokens.pop() ?? "";
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

function createFilterCompletionList(): AutocompleteItem[] {
  const entries: AutocompleteItem[] = [];
  const add = (value: string, desc: string) => {
    entries.push(
      createAutocompleteItem(`severity:${value}`, desc),
      createAutocompleteItem(value, desc),
    );
  };
  for (const value of SONAR_SEVERITIES) add(value, "severity");
  for (const value of SONAR_STATUSES) add(value, "status");
  for (const value of SONAR_TYPES) add(value, "type");
  return entries;
}

export function sonarArgumentCompletions(
  argumentText: string,
  issues?: SonarIssue[],
): AutocompleteItem[] | null {
  const { command, current, tokens } = splitSonarArgumentContext(argumentText);
  const lowerCommand = command.toLowerCase();
  const commandMatches = SONAR_COMMANDS.filter((item) => item.value.startsWith(lowerCommand));
  const isFullMatch = SONAR_COMMANDS.some((item) => item.value === lowerCommand);

  if (!command || commandMatches.length > 1 || !isFullMatch) {
    if (commandMatches.length === 0) return null;
    return commandMatches.map((item) => createAutocompleteItem(item.value, item.description));
  }

  if (lowerCommand === "open") {
    const issueItems = (issues ?? []).slice(0, 10).map((issue, index) => {
      const lineSuffix = issue.line ? `:${issue.line}` : "";
      return createAutocompleteItem(
        String(index + 1),
        `${issue.severity} ${issue.filePath}${lineSuffix}`,
      );
    });
    const suggestions = [...issueItems, ...createFilterCompletionList()];
    const filtered = filterAutocompleteItems(suggestions, current);
    return filtered.length > 0 ? filtered : null;
  }

  if (lowerCommand === "analyze" || lowerCommand === "issues") {
    const suggestions = createFilterCompletionList();
    const filtered = filterAutocompleteItems(suggestions, current);
    return filtered.length > 0 ? filtered : null;
  }

  if (lowerCommand === "init") {
    return null;
  }

  return tokens.length === 0 ? filterAutocompleteItems(SONAR_COMMANDS, current) : null;
}

// ── Command arg parsing ─────────────────────────────────────────────────────

export type ParsedSonarCommand =
  | { action: "help" }
  | { action: "init"; alias?: string; targetInput?: string }
  | { action: "analyze"; targetInput?: string; filters?: SonarIssueFetchOptions }
  | { action: "issues"; targetInput?: string; filters?: SonarIssueFetchOptions }
  | { action: "open"; targetInput?: string; issueIndex?: number; filters?: SonarIssueFetchOptions };

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
    "  /sonarqube                       show this help",
    "",
    "Filters:",
    "  /sonarqube issues be CRITICAL",
    "  /sonarqube issues be severity:CRITICAL status:OPEN",
    "",
    "Autocomplete:",
    "  type /sonarqube and press Tab to complete the subcommand or filters",
    "",
    "Defaults:",
    "  config is stored in .pi/sonarqube.json",
    "  use project paths directly (no alias needed)",
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
  const prefix = typeof index === "number" ? `${String(index).padStart(2, "0")}. ` : "";
  const rule = issue.ruleName ? `${issue.rule} (${issue.ruleName})` : issue.rule;
  return `${prefix}${issue.severity} ${loc} — ${rule} — ${issue.message}`;
}

export function formatSummary(state: { totalIssues: number; projectKey: string; filters?: SonarIssueFetchOptions }): string {
  const issueCount = state.totalIssues;
  const filterLabel = state.filters ? ` (${issueFilterLabel(state.filters)})` : "";
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
    lines.push("", state.measures.duplicatedBlocks > 0
      ? `Duplication: ${state.measures.duplicatedLinesDensity.toFixed(1)}%  lines=${state.measures.duplicatedLines}  blocks=${state.measures.duplicatedBlocks}  files=${state.measures.duplicatedFiles}`
      : `Duplication: ${state.measures.duplicatedLinesDensity.toFixed(1)}%  (no duplications detected)`);
  }

  if (state.issues.length === 0) {
    lines.push("No open issues found.");
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
