import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AutocompleteItem, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { Type } from "typebox";

// ── Public types ──────────────────────────────────────────────────────────────

export type SonarAction = "analyze" | "issues" | "open" | "init";

export interface SonarIssue {
  key: string;
  rule: string;
  ruleName?: string;
  severity: string;
  message: string;
  filePath: string;
  line: number | null;
  status?: string;
}

export interface SonarAnalysisState {
  version: 1;
  analyzedAt: string;
  baseDir: string;
  serverUrl: string;
  projectKey: string;
  dashboardUrl?: string;
  ceTaskUrl?: string;
  analysisId?: string;
  filters?: SonarIssueFetchOptions;
  totalIssues: number;
  issues: SonarIssue[];
}

export interface SonarProjectConfig {
  baseDir: string;
  serverUrl: string;
  projectKey: string;
  token?: string;
  hasProperties: boolean;
}

export interface SonarIssueFetchOptions {
  severities?: string[];
  statuses?: string[];
  types?: string[];
  rules?: string[];
}

export interface SonarInitConfig {
  serverUrl: string;
  projectKey: string;
  token?: string;
}

// ── Internal types / state keys ───────────────────────────────────────────────

const STATE_TYPE = "sonarqube-analysis-state";

const SonarToolParams = Type.Object({
  action: StringEnum(["analyze", "issues", "open"] as const),
  path: Type.Optional(Type.String({ description: "Target alias or project directory to analyze or inspect" })),
  issueIndex: Type.Optional(Type.Number({ description: "1-based issue index to open" })),
  severities: Type.Optional(Type.Array(Type.String({ description: "Issue severity to fetch (e.g. CRITICAL)" }))),
  statuses: Type.Optional(Type.Array(Type.String({ description: "Issue status to fetch (e.g. OPEN)" }))),
  types: Type.Optional(Type.Array(Type.String({ description: "Issue type to fetch (e.g. BUG)" }))),
  rules: Type.Optional(Type.Array(Type.String({ description: "Rule keys to fetch" }))),
});

const SONAR_COMMANDS = [
  { value: "analyze", label: "analyze", description: "run analysis and fetch issues" },
  { value: "issues", label: "issues", description: "browse the latest issues" },
  { value: "open", label: "open", description: "preview a specific issue" },
  { value: "init", label: "init", description: "configure a project target" },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "sonarqube"
  );
}

function normalizePath(input: string, cwd: string): string {
  const trimmed = input.trim().replace(/^@/, "");
  return resolve(cwd, trimmed);
}

function parseProperties(text: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const sep = line.indexOf("=");
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key) props[key] = value;
  }
  return props;
}

function normalizeServerUrl(url: string | undefined): string {
  const fallback = "http://localhost:9000";
  if (!url?.trim()) return fallback;
  return url.trim().replace(/\/+$/, "");
}

const SONAR_SEVERITIES = ["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"] as const;
const SONAR_STATUSES = ["OPEN", "CONFIRMED", "REOPENED", "RESOLVED", "CLOSED"] as const;
const SONAR_TYPES = ["BUG", "VULNERABILITY", "CODE_SMELL"] as const;

function createAutocompleteItem(value: string, description?: string): AutocompleteItem {
  return description ? { value, label: value, description } : { value, label: value };
}

function filterAutocompleteItems(
  items: readonly { value: string; label: string; description?: string }[],
  prefix: string,
): AutocompleteItem[] {
  const query = prefix.trim().toLowerCase();
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().startsWith(query))
    : [...items];
  return filtered.map((item) => ({ value: item.value, label: item.label, description: item.description }));
}

function mergeAutocompleteSuggestions(
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

function splitSonarArgumentContext(argumentText: string): { command: string; current: string; tokens: string[] } {
  const trimmedLeft = argumentText.replace(/^\s+/, "");
  if (!trimmedLeft) return { command: "", current: "", tokens: [] };

  const tokens = trimmedLeft.split(/\s+/);
  const current = /\s$/.test(argumentText) ? "" : tokens.pop() ?? "";
  return { command: tokens[0] ?? current, current, tokens: tokens.length > 0 ? tokens : current ? [current] : [] };
}

function createFilterCompletionList(): AutocompleteItem[] {
  return [
    ...SONAR_SEVERITIES.flatMap((value) => [
      createAutocompleteItem(`severity:${value}`, "severity"),
      createAutocompleteItem(value, "severity"),
    ]),
    ...SONAR_STATUSES.flatMap((value) => [
      createAutocompleteItem(`status:${value}`, "status"),
      createAutocompleteItem(value, "status"),
    ]),
    ...SONAR_TYPES.flatMap((value) => [
      createAutocompleteItem(`type:${value}`, "type"),
      createAutocompleteItem(value, "type"),
    ]),
  ];
}

function sonarArgumentCompletions(argumentText: string, issues?: SonarIssue[]): AutocompleteItem[] | null {
  const { command, current, tokens } = splitSonarArgumentContext(argumentText);
  const lowerCommand = command.toLowerCase();
  const commandMatches = SONAR_COMMANDS.filter((item) => item.value.startsWith(lowerCommand));

  if (!command || commandMatches.length > 1 || !SONAR_COMMANDS.some((item) => item.value === lowerCommand)) {
    return commandMatches.length > 0 ? commandMatches.map((item) => createAutocompleteItem(item.value, item.description)) : null;
  }

  if (lowerCommand === "open") {
    const issueItems = (issues ?? []).slice(0, 10).map((issue, index) =>
      createAutocompleteItem(
        String(index + 1),
        `${issue.severity} ${issue.filePath}${issue.line ? `:${issue.line}` : ""}`,
      ),
    );
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveProjectKey(baseDir: string, props: Record<string, string>): string {
  const fromProps = props["sonar.projectKey"]?.trim();
  if (fromProps) return fromProps;
  return slugify(basename(baseDir));
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function projectConfigPath(baseDir: string): string {
  return resolve(baseDir, CONFIG_DIR_NAME, "sonarqube.json");
}

function sonarqubeConfigDir(baseDir: string): string {
  return resolve(baseDir, CONFIG_DIR_NAME);
}

function sonarProjectPropertiesPath(baseDir: string): string {
  return resolve(baseDir, "sonar-project.properties");
}

const DEFAULT_SONAR_EXCLUSIONS = [
  "**/node_modules/**",
  "dist/**",
  "coverage/**",
  ".scannerwork/**",
  "**/.env*",
];

const DEFAULT_SONAR_PROJECT_PROPERTIES = [
  "sonar.sources=.",
  `sonar.exclusions=${DEFAULT_SONAR_EXCLUSIONS.join(",")}`,
].join("\n") + "\n";

function mergeCommaSeparatedValues(existingValue: string | undefined, additions: string[]): string {
  const merged = new Set(
    (existingValue ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  for (const addition of additions) {
    const trimmed = addition.trim();
    if (trimmed) merged.add(trimmed);
  }

  return [...merged].join(",");
}

async function ensureDefaultSonarProjectProperties(baseDir: string): Promise<"created" | "updated" | "unchanged"> {
  const path = sonarProjectPropertiesPath(baseDir);
  const existing = await readOptionalText(path);
  if (!existing?.trim()) {
    await writeFile(path, DEFAULT_SONAR_PROJECT_PROPERTIES, "utf8");
    return "created";
  }

  const lines = existing.split(/\r?\n/);
  let hasSources = false;
  let hasExclusions = false;
  let changed = false;

  const updatedLines = lines.map((line) => {
    const match = line.match(/^(\s*)(sonar\.(?:sources|exclusions))\s*=\s*(.*)$/);
    if (!match) return line;

    const indent = match[1] ?? "";
    const key = match[2];
    const value = match[3] ?? "";

    if (key === "sonar.sources") {
      hasSources = true;
      const trimmedValue = value.trim();
      if (trimmedValue) return line;
      changed = true;
      return `${indent}sonar.sources=.`;
    }

    if (key === "sonar.exclusions") {
      hasExclusions = true;
      const merged = mergeCommaSeparatedValues(value, DEFAULT_SONAR_EXCLUSIONS);
      if (merged === value.trim()) return line;
      changed = true;
      return `${indent}sonar.exclusions=${merged}`;
    }

    return line;
  });

  if (!hasSources) {
    updatedLines.push("sonar.sources=.");
    changed = true;
  }
  if (!hasExclusions) {
    updatedLines.push(`sonar.exclusions=${DEFAULT_SONAR_EXCLUSIONS.join(",")}`);
    changed = true;
  }

  if (!changed) {
    return "unchanged";
  }

  const normalized = updatedLines.join("\n").replace(/\n*$/, "\n");
  await writeFile(path, normalized, "utf8");
  return existing.includes("sonar.sources") || existing.includes("sonar.exclusions") ? "updated" : "created";
}

/**
 * Load project-local config from `.pi/sonarqube.json`.
 * Returns undefined when the file doesn't exist or is invalid.
 */
async function loadProjectConfig(baseDir: string): Promise<SonarInitConfig | undefined> {
  return readOptionalJson<SonarInitConfig>(projectConfigPath(baseDir));
}

/**
 * Save project-local config to `.pi/sonarqube.json`.
 */
async function saveProjectConfig(baseDir: string, config: SonarInitConfig): Promise<void> {
  const dir = sonarqubeConfigDir(baseDir);
  await mkdir(dir, { recursive: true });
  await writeFile(projectConfigPath(baseDir), JSON.stringify(config, null, 2) + "\n", "utf8");
}

interface SonarWorkspaceRegistry {
  version: 1;
  workspaces: Record<string, string>;
}

interface ResolvedTarget {
  baseDir: string;
  repoRoot: string;
  alias?: string;
}

const WORKSPACE_REGISTRY_FILE = "sonarqube.workspaces.json";

function workspaceRegistryPath(repoRoot: string): string {
  return resolve(repoRoot, CONFIG_DIR_NAME, WORKSPACE_REGISTRY_FILE);
}

async function hasGitRootMarker(dir: string): Promise<boolean> {
  try {
    const entry = await stat(resolve(dir, ".git"));
    return entry.isDirectory() || entry.isFile();
  } catch {
    return false;
  }
}

async function findRepoRoot(startDir: string): Promise<string> {
  let dir = resolve(startDir);
  for (;;) {
    if (await hasGitRootMarker(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

async function loadWorkspaceRegistry(startDir: string): Promise<{ repoRoot: string; registry: SonarWorkspaceRegistry }> {
  const repoRoot = await findRepoRoot(startDir);
  const raw = await readOptionalJson<Partial<SonarWorkspaceRegistry>>(workspaceRegistryPath(repoRoot));
  const workspaces = raw?.workspaces && typeof raw.workspaces === "object" ? { ...raw.workspaces } : {};
  return { repoRoot, registry: { version: 1, workspaces: workspaces as Record<string, string> } };
}

async function saveWorkspaceRegistry(startDir: string, alias: string, targetDir: string): Promise<void> {
  const { repoRoot, registry } = await loadWorkspaceRegistry(startDir);
  registry.workspaces[alias] = relative(repoRoot, targetDir) || ".";
  await mkdir(sonarqubeConfigDir(repoRoot), { recursive: true });
  await writeFile(workspaceRegistryPath(repoRoot), JSON.stringify(registry, null, 2) + "\n", "utf8");
}

function looksLikePath(token: string): boolean {
  return (
    token === "." ||
    token === ".." ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("/") ||
    token.startsWith("~") ||
    token.includes("/") ||
    token.includes("\\")
  );
}

function knownTargets(registry: SonarWorkspaceRegistry): string[] {
  return Object.keys(registry.workspaces).sort((left, right) => left.localeCompare(right));
}

async function resolveTarget(ctx: ExtensionContext, targetInput?: string): Promise<ResolvedTarget> {
  const { repoRoot, registry } = await loadWorkspaceRegistry(ctx.cwd);
  if (!targetInput) {
    return { baseDir: ctx.cwd, repoRoot };
  }

  const aliasTarget = registry.workspaces[targetInput];
  if (aliasTarget) {
    const baseDir = resolve(repoRoot, aliasTarget);
    const baseDirStat = await stat(baseDir).catch(() => undefined);
    if (!baseDirStat?.isDirectory()) {
      throw new Error(`SonarQube target "${targetInput}" points to a missing directory: ${baseDir}`);
    }
    return { baseDir, repoRoot, alias: targetInput };
  }

  if (looksLikePath(targetInput)) {
    const baseDir = normalizePath(targetInput, ctx.cwd);
    const baseDirStat = await stat(baseDir).catch(() => undefined);
    if (!baseDirStat?.isDirectory()) {
      throw new Error(`SonarQube target path not found: ${baseDir}`);
    }
    return { baseDir, repoRoot };
  }

  const known = knownTargets(registry);
  if (known.length > 0) {
    throw new Error(
      `Unknown SonarQube target "${targetInput}". Known targets: ${known.join(", ")}. Use /sonarqube init <alias> <path> to add one.`,
    );
  }

  throw new Error(`Unknown SonarQube target "${targetInput}". Use /sonarqube init <alias> <path> to add one.`);
}

async function resolveInitTarget(
  ctx: ExtensionContext,
  alias?: string,
  targetInput?: string,
): Promise<ResolvedTarget> {
  if (targetInput) {
    const resolved = await resolveTarget(ctx, targetInput);
    return { ...resolved, alias };
  }

  const { repoRoot } = await loadWorkspaceRegistry(ctx.cwd);
  return { baseDir: ctx.cwd, repoRoot, alias };
}

export { projectConfigPath, loadProjectConfig, saveProjectConfig, sonarqubeConfigDir };

// ── Config resolution (env > .pi/sonarqube.json > sonar-project.properties) ────

async function resolveConfig(ctx: ExtensionContext, inputPath?: string): Promise<SonarProjectConfig> {
  const { baseDir } = await resolveTarget(ctx, inputPath);
  const propertiesPath = resolve(baseDir, "sonar-project.properties");
  const propertiesText = await readOptionalText(propertiesPath);
  const props = propertiesText ? parseProperties(propertiesText) : {};
  const projectCfg = await loadProjectConfig(baseDir);

  const serverUrl = normalizeServerUrl(
    process.env.SONARQUBE_URL ??
      process.env.SONAR_HOST_URL ??
      projectCfg?.serverUrl?.trim() ??
      props["sonar.host.url"],
  );
  const projectKey =
    process.env.SONAR_PROJECT_KEY?.trim() ||
    projectCfg?.projectKey?.trim() ||
    props["sonar.projectKey"]?.trim() ||
    resolveProjectKey(baseDir, props);
  const token =
    process.env.SONARQUBE_TOKEN?.trim() ||
    process.env.SONAR_TOKEN?.trim() ||
    projectCfg?.token?.trim() ||
    props["sonar.token"]?.trim();

  return {
    baseDir,
    serverUrl,
    projectKey,
    token: token || undefined,
    hasProperties: Boolean(propertiesText),
  };
}

// ── Auth / API helpers ────────────────────────────────────────────────────────

function authHeader(token?: string): string | undefined {
  if (!token) return undefined;
  return `Basic ${Buffer.from(`${token}:`).toString("base64")}`;
}

async function fetchJson<T>(url: string, token?: string, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const auth = authHeader(token);
  if (auth) headers.Authorization = auth;

  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const suffix = body.trim() ? `: ${body.trim().slice(0, 240)}` : "";
    throw new Error(`SonarQube API request failed (${response.status} ${response.statusText}) for ${url}${suffix}`);
  }

  return (await response.json()) as T;
}

function toIssuePath(component: string, projectKey: string): string {
  const prefix = `${projectKey}:`;
  if (component.startsWith(prefix)) return component.slice(prefix.length);
  const colon = component.indexOf(":");
  return colon >= 0 ? component.slice(colon + 1) : component;
}

function normalizeIssueList(values?: string[], uppercase = false): string[] | undefined {
  const cleaned = values
    ?.map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (uppercase ? value.toUpperCase() : value));
  if (!cleaned?.length) return undefined;
  return [...new Set(cleaned)];
}

function normalizeIssueFilters(filters?: SonarIssueFetchOptions): SonarIssueFetchOptions | undefined {
  const normalized = {
    severities: normalizeIssueList(filters?.severities, true),
    statuses: normalizeIssueList(filters?.statuses, true),
    types: normalizeIssueList(filters?.types, true),
    rules: normalizeIssueList(filters?.rules),
  };
  return normalized.severities || normalized.statuses || normalized.types || normalized.rules ? normalized : undefined;
}

function mergeIssueFilters(...filters: Array<Partial<SonarIssueFetchOptions> | undefined>): SonarIssueFetchOptions | undefined {
  const merged: SonarIssueFetchOptions = {};
  for (const filter of filters) {
    if (!filter) continue;
    if (filter.severities?.length) merged.severities = [...(merged.severities ?? []), ...filter.severities];
    if (filter.statuses?.length) merged.statuses = [...(merged.statuses ?? []), ...filter.statuses];
    if (filter.types?.length) merged.types = [...(merged.types ?? []), ...filter.types];
    if (filter.rules?.length) merged.rules = [...(merged.rules ?? []), ...filter.rules];
  }
  return normalizeIssueFilters(merged);
}

function splitFilterValues(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function parseIssueFilterToken(token: string): Partial<SonarIssueFetchOptions> | undefined {
  const trimmed = token.trim();
  if (!trimmed) return undefined;

  const explicit = trimmed.match(/^([^:=]+)[:=](.+)$/);
  if (explicit) {
    const key = explicit[1].trim().toLowerCase();
    const values = splitFilterValues(explicit[2]);
    if (values.length === 0) return undefined;

    if (key === "severity" || key === "severities") return { severities: values.map((value) => value.toUpperCase()) };
    if (key === "status" || key === "statuses") return { statuses: values.map((value) => value.toUpperCase()) };
    if (key === "type" || key === "types") return { types: values.map((value) => value.toUpperCase()) };
    if (key === "rule" || key === "rules") return { rules: values };
    return undefined;
  }

  const upper = trimmed.toUpperCase();
  if (SONAR_SEVERITIES.includes(upper as (typeof SONAR_SEVERITIES)[number])) return { severities: [upper] };
  if (SONAR_STATUSES.includes(upper as (typeof SONAR_STATUSES)[number])) return { statuses: [upper] };
  if (SONAR_TYPES.includes(upper as (typeof SONAR_TYPES)[number])) return { types: [upper] };
  return undefined;
}

interface ParsedSonarIssueArgs {
  targetInput?: string;
  issueIndex?: number;
  filters?: SonarIssueFetchOptions;
}

function parseSonarIssueArgs(tokens: string[], allowIssueIndex = false): ParsedSonarIssueArgs {
  const filters: Array<Partial<SonarIssueFetchOptions> | undefined> = [];
  let targetInput: string | undefined;
  let issueIndex: number | undefined;

  for (const token of tokens) {
    if (!token) continue;
    if (allowIssueIndex && issueIndex === undefined && /^\d+$/.test(token)) {
      issueIndex = Number(token);
      continue;
    }

    const parsedFilter = parseIssueFilterToken(token);
    if (parsedFilter) {
      filters.push(parsedFilter);
      continue;
    }

    if (!targetInput) {
      targetInput = token;
    }
  }

  return {
    targetInput,
    issueIndex,
    filters: mergeIssueFilters(...filters),
  };
}

function issueFilterLabel(filters?: SonarIssueFetchOptions): string {
  if (!filters) return "";
  const parts = [
    filters.severities?.length ? `severities=${filters.severities.join(",")}` : "",
    filters.statuses?.length ? `statuses=${filters.statuses.join(",")}` : "",
    filters.types?.length ? `types=${filters.types.join(",")}` : "",
    filters.rules?.length ? `rules=${filters.rules.join(",")}` : "",
  ].filter(Boolean);
  return parts.join(" • ");
}

function severitySortRank(severity: string): number {
  switch (severity.toUpperCase()) {
    case "BLOCKER":
      return 0;
    case "CRITICAL":
      return 1;
    case "MAJOR":
      return 2;
    case "MINOR":
      return 3;
    case "INFO":
      return 4;
    default:
      return 5;
  }
}

function compareIssuesForContext(left: SonarIssue, right: SonarIssue): number {
  const severityDiff = severitySortRank(left.severity) - severitySortRank(right.severity);
  if (severityDiff !== 0) return severityDiff;
  const fileDiff = left.filePath.localeCompare(right.filePath);
  if (fileDiff !== 0) return fileDiff;
  const leftLine = left.line ?? Number.POSITIVE_INFINITY;
  const rightLine = right.line ?? Number.POSITIVE_INFINITY;
  if (leftLine !== rightLine) return leftLine - rightLine;
  return left.message.localeCompare(right.message);
}

// ── Issue helpers ─────────────────────────────────────────────────────────────

function buildIssuePreview(baseDir: string, issue: SonarIssue, radius = 3): Promise<string> {
  return (async () => {
    const filePath = resolve(baseDir, issue.filePath);
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const target = issue.line ?? 1;
    const start = Math.max(1, target - radius);
    const end = Math.min(lines.length, target + radius);
    const width = String(end).length;

    const rendered: string[] = [];
    for (let line = start; line <= end; line++) {
      const marker = line === target ? ">" : " ";
      const num = String(line).padStart(width, " ");
      rendered.push(`${marker} ${num} | ${lines[line - 1] ?? ""}`);
    }

    return rendered.join("\n");
  })();
}

function formatIssue(issue: SonarIssue, index?: number): string {
  const loc = issue.line ? `${issue.filePath}:${issue.line}` : issue.filePath;
  const prefix = index !== undefined ? `${String(index).padStart(2, "0")}. ` : "";
  const rule = issue.ruleName ? `${issue.rule} (${issue.ruleName})` : issue.rule;
  return `${prefix}${issue.severity} ${loc} — ${rule} — ${issue.message}`;
}

function formatSummary(state: SonarAnalysisState): string {
  const issueCount = state.totalIssues;
  const noIssues = issueCount === 0;
  const filterLabel = state.filters ? ` (${issueFilterLabel(state.filters)})` : "";
  return noIssues
    ? `SonarQube: no issues found for ${state.projectKey}${filterLabel}`
    : `SonarQube: ${issueCount} issue${issueCount === 1 ? "" : "s"} found for ${state.projectKey}${filterLabel}`;
}

function formatReport(state: SonarAnalysisState): string {
  const lines = [
    `Project: ${state.projectKey}`,
    `Server: ${state.serverUrl}`,
    `Base dir: ${state.baseDir}`,
    `Issues: ${state.totalIssues}`,
  ];

  if (state.filters) {
    lines.push(`Filters: ${issueFilterLabel(state.filters)}`);
  }

  if (state.issues.length === 0) {
    lines.push("No open issues found.");
    return lines.join("\n");
  }

  lines.push("");
  for (const [index, issue] of state.issues.slice(0, 10).entries()) {
    lines.push(formatIssue(issue, index + 1));
  }
  if (state.issues.length > 10) {
    lines.push(`... ${state.issues.length - 10} more`);
  }
  return lines.join("\n");
}



function severityColor(theme: Theme, severity: string): string {
  switch (severity.toLowerCase()) {
    case "blocker":
    case "critical":
      return theme.fg("error", severity);
    case "major":
      return theme.fg("warning", severity);
    case "minor":
      return theme.fg("accent", severity);
    default:
      return theme.fg("muted", severity);
  }
}

const ANALYSIS_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const ANALYSIS_WIDGET_KEY = "sonarqube-analysis";

interface AnalysisUiHandle {
  setPhase(phase: string): void;
  stop(): void;
}

function startAnalysisUi(ctx: ExtensionContext, projectKey: string): AnalysisUiHandle {
  let frameIndex = 0;
  let phase = "Starting...";
  const render = () => {
    const frame = ANALYSIS_SPINNER[frameIndex];
    ctx.ui.setWidget(ANALYSIS_WIDGET_KEY, [`${frame} SonarQube ${projectKey}`, phase]);
  };

  ctx.ui.setWorkingMessage(`Analyzing ${projectKey}...`);
  ctx.ui.setWorkingIndicator({ frames: ANALYSIS_SPINNER as unknown as string[], intervalMs: 80 });
  render();

  const timer = setInterval(() => {
    frameIndex = (frameIndex + 1) % ANALYSIS_SPINNER.length;
    render();
  }, 80);

  return {
    setPhase(nextPhase: string) {
      phase = nextPhase;
      render();
    },
    stop() {
      clearInterval(timer);
      ctx.ui.setWidget(ANALYSIS_WIDGET_KEY, undefined);
      ctx.ui.setWorkingMessage();
      ctx.ui.setWorkingIndicator();
    },
  };
}

// ── Issue Browser UI component ────────────────────────────────────────────────

class IssueBrowser {
  private selected = 0;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly state: SonarAnalysisState,
    private readonly theme: Theme,
    private readonly done: (result: number | null) => void,
  ) {}

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
      this.done(null);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selected = Math.min(this.state.issues.length - 1, this.selected + 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(this.selected);
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const title = this.theme.fg("accent", this.theme.bold(" SonarQube Issues "));
    const subtitleText = this.state.filters
      ? `${this.state.projectKey} • ${this.state.totalIssues} issue(s) • ${issueFilterLabel(this.state.filters)}`
      : `${this.state.projectKey} • ${this.state.totalIssues} issue(s)`;
    const subtitle = this.theme.fg("dim", subtitleText);
    lines.push(truncateToWidth(title, width));
    lines.push(truncateToWidth(subtitle, width));
    lines.push("");

    const pageSize = Math.min(20, this.state.issues.length);
    const halfWindow = Math.floor(pageSize / 2);
    const maxStart = Math.max(0, this.state.issues.length - pageSize);
    const start = Math.max(0, Math.min(this.selected - halfWindow, maxStart));
    const end = Math.min(this.state.issues.length, start + pageSize);
    const visibleIssues = this.state.issues.slice(start, end);

    if (visibleIssues.length === 0) {
      lines.push(truncateToWidth(this.theme.fg("success", "No open issues found."), width));
    } else {
      if (start > 0) {
        lines.push(truncateToWidth(this.theme.fg("dim", `... ${start} more above`), width));
      }
      visibleIssues.forEach((issue, index) => {
        const issueIndex = start + index;
        const selected = issueIndex === this.selected;
        const marker = selected ? this.theme.fg("accent", ">") : this.theme.fg("dim", " ");
        const location = issue.line ? `${issue.filePath}:${issue.line}` : issue.filePath;
        const rule = issue.ruleName ? `${issue.rule} (${issue.ruleName})` : issue.rule;
        const severity = severityColor(this.theme, issue.severity);
        const summary = `${marker} ${String(issueIndex + 1).padStart(2, "0")}. ${severity} ${this.theme.fg(
          "accent",
          location,
        )} ${this.theme.fg("muted", rule)} ${this.theme.fg("text", `— ${issue.message}`)}`;
        lines.push(truncateToWidth(summary, width));
      });
      if (end < this.state.issues.length) {
        lines.push(truncateToWidth(this.theme.fg("dim", `... ${this.state.issues.length - end} more below`), width));
      }
    }

    lines.push("");
    lines.push(truncateToWidth(this.theme.fg("dim", "Up/Down to move, Enter to preview, Esc to close"), width));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

// ── State restoration ─────────────────────────────────────────────────────────

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

// ── Error hints ───────────────────────────────────────────────────────────────

function sonarScannerInstallHint(): string {
  return [
    "SonarScanner is not installed or not on PATH.",
    "Please install SonarScanner and make sure `sonar-scanner` is available, then retry.",
  ].join(" ");
}

function extractScannerHint(output: string, config: SonarProjectConfig, exitCode?: number): string {
  const lines = output.toLowerCase();

  if (
    exitCode === 127 ||
    /spawn .*enoent|enoent|command not found|is not recognized as an internal or external command/i.test(lines)
  ) {
    return sonarScannerInstallHint();
  }

  if (/status code 401|status 401|unauthorized/i.test(lines)) {
    const defaultHint = config.serverUrl === "http://localhost:9000"
      ? " (default: http://localhost:9000)"
      : "";
    return [
      `Authentication failed for ${config.serverUrl}${defaultHint}.`,
      "Run `/sonarqube init` to set up your server URL and token, then retry.",
      "Or set SONARQUBE_TOKEN in your environment.",
    ].join(" ");
  }

  if (/status code 403|status 403|forbidden/i.test(lines)) {
    return [
      `Access denied by ${config.serverUrl}.`,
      'Your token may not have the required permissions ("Execute Analysis").',
      "Run `/sonarqube init` to update the token or check server permissions.",
    ].join(" ");
  }

  if (/connect econnrefused|connect refused|connect timeout|enotfound|econnreset/i.test(lines)) {
    return [
      `Cannot reach SonarQube server at ${config.serverUrl}.`,
      "Is the server running? Run `/sonarqube init` to check the server URL.",
      "Default: http://localhost:9000",
    ].join(" ");
  }

  if (/not found|unknown url/i.test(lines) && (config.serverUrl === "http://localhost:9000" || /localhost/i.test(config.serverUrl))) {
    return [
      `SonarQube API at ${config.serverUrl} returned "not found".`,
      "The default server URL is http://localhost:9000. Run `/sonarqube init` to configure.",
    ].join(" ");
  }

  return "";
}

// ── SonarScanner interaction ─────────────────────────────────────────────────

async function runScanner(pi: ExtensionAPI, config: SonarProjectConfig, signal?: AbortSignal): Promise<string> {
  const scannerCheck =
    process.platform === "win32"
      ? await pi.exec("cmd", ["/d", "/s", "/c", "where", "sonar-scanner"], {
          cwd: config.baseDir,
          signal,
          timeout: 10_000,
        })
      : await pi.exec("sh", ["-lc", "command -v sonar-scanner"], {
          cwd: config.baseDir,
          signal,
          timeout: 10_000,
        });

  if (scannerCheck.code !== 0 || !scannerCheck.stdout.trim()) {
    throw new Error(sonarScannerInstallHint());
  }

  const args = [
    `-Dsonar.projectKey=${config.projectKey}`,
    `-Dsonar.projectBaseDir=${config.baseDir}`,
    `-Dsonar.host.url=${config.serverUrl}`,
    ...(config.hasProperties ? [] : [`-Dsonar.sources=.`]),
    `-Dsonar.scm.disabled=true`,
  ];
  if (config.token) {
    args.push(`-Dsonar.token=${config.token}`);
  }

  const result = await pi.exec("sonar-scanner", args, {
    cwd: config.baseDir,
    signal,
    timeout: 30 * 60 * 1000,
  });
  if (result.code !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    const hint = extractScannerHint(output, config, result.code);
    const detail = output ? `\n\n${output.slice(-4000)}` : "";
    const message = hint
      ? `SonarQube scan failed for ${config.projectKey}. ${hint}`
      : `SonarQube scan failed for ${config.projectKey}${detail}`;
    throw new Error(message);
  }

  return result.stdout || result.stderr;
}

async function readReportTask(baseDir: string): Promise<Record<string, string>> {
  const path = resolve(baseDir, ".scannerwork", "report-task.txt");
  const text = await readFile(path, "utf8");
  return parseProperties(text);
}

async function waitForAnalysis(
  serverUrl: string,
  token: string | undefined,
  ceTaskUrl: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await fetchJson<{
      task: { status: string; analysisId?: string; errorMessage?: string };
    }>(ceTaskUrl, token, signal);
    const status = result.task.status.toUpperCase();
    if (status === "SUCCESS") return result.task.analysisId;
    if (status === "FAILED") {
      throw new Error(`SonarQube analysis failed: ${result.task.errorMessage || "unknown error"}`);
    }
    if (status === "CANCELED") {
      throw new Error("SonarQube analysis was canceled by the server");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
  }

  throw new Error(`Timed out waiting for SonarQube analysis at ${serverUrl}`);
}

async function fetchRuleName(
  serverUrl: string,
  token: string | undefined,
  ruleKey: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await fetchJson<{ rule: { name?: string } }>(
      `${serverUrl}/api/rules/show?key=${encodeURIComponent(ruleKey)}`,
      token,
      signal,
    );
    return result.rule.name;
  } catch {
    return undefined;
  }
}

async function fetchIssues(
  serverUrl: string,
  token: string | undefined,
  projectKey: string,
  signal?: AbortSignal,
  filters?: SonarIssueFetchOptions,
): Promise<SonarIssue[]> {
  const normalizedFilters = normalizeIssueFilters(filters);
  const issues: SonarIssue[] = [];
  const ruleNames = new Map<string, string | undefined>();
  let page = 1;
  let total = 0;

  for (;;) {
    const url = new URL("/api/issues/search", serverUrl);
    url.searchParams.set("projects", projectKey);
    url.searchParams.set("resolved", "false");
    url.searchParams.set("ps", "100");
    url.searchParams.set("p", String(page));
    if (normalizedFilters?.severities?.length) {
      url.searchParams.set("severities", normalizedFilters.severities.join(","));
    }
    if (normalizedFilters?.statuses?.length) {
      url.searchParams.set("statuses", normalizedFilters.statuses.join(","));
    }
    if (normalizedFilters?.types?.length) {
      url.searchParams.set("types", normalizedFilters.types.join(","));
    }
    if (normalizedFilters?.rules?.length) {
      url.searchParams.set("rules", normalizedFilters.rules.join(","));
    }

    const result = await fetchJson<{
      total: number;
      issues: Array<{
        key: string;
        rule: string;
        severity: string;
        message: string;
        component: string;
        line?: number;
        status?: string;
      }>;
    }>(url.toString(), token, signal);

    total = result.total;
    for (const raw of result.issues) {
      if (!ruleNames.has(raw.rule)) {
        ruleNames.set(raw.rule, await fetchRuleName(serverUrl, token, raw.rule, signal));
      }
      issues.push({
        key: raw.key,
        rule: raw.rule,
        ruleName: ruleNames.get(raw.rule),
        severity: raw.severity,
        message: raw.message,
        filePath: toIssuePath(raw.component, projectKey),
        line: typeof raw.line === "number" ? raw.line : null,
        status: raw.status,
      });
    }

    if (issues.length >= total || result.issues.length === 0) break;
    page += 1;
  }

  if (normalizedFilters && issues.length > 1) {
    issues.sort(compareIssuesForContext);
  }

  return issues;
}

function createAnalysisState(
  config: Pick<SonarProjectConfig, "baseDir" | "serverUrl" | "projectKey">,
  issues: SonarIssue[],
  extras: Partial<Pick<SonarAnalysisState, "dashboardUrl" | "ceTaskUrl" | "analysisId" | "filters">> = {},
): SonarAnalysisState {
  return {
    version: 1,
    analyzedAt: nowIso(),
    baseDir: config.baseDir,
    serverUrl: config.serverUrl,
    projectKey: config.projectKey,
    dashboardUrl: extras.dashboardUrl,
    ceTaskUrl: extras.ceTaskUrl,
    analysisId: extras.analysisId,
    filters: extras.filters,
    totalIssues: issues.length,
    issues,
  };
}

async function hasProjectAnalyses(
  serverUrl: string,
  token: string | undefined,
  projectKey: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const result = await fetchJson<{ analyses?: Array<{ key?: string }> }>(
      `${serverUrl}/api/project_analyses/search?project=${encodeURIComponent(projectKey)}&ps=1`,
      token,
      signal,
    );
    return (result.analyses?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

async function loadProjectIssuesFromApi(
  ctx: ExtensionContext,
  inputPath?: string,
  filters?: SonarIssueFetchOptions,
): Promise<SonarAnalysisState> {
  const config = await resolveConfig(ctx, inputPath);
  const normalizedFilters = normalizeIssueFilters(filters);
  const issues = await fetchIssues(config.serverUrl, config.token, config.projectKey, ctx.signal, normalizedFilters);
  return createAnalysisState(config, issues, { filters: normalizedFilters });
}

async function resolveTargetState(
  ctx: ExtensionContext,
  statesByBaseDir: Map<string, SonarAnalysisState>,
  targetInput?: string,
  filters?: SonarIssueFetchOptions,
): Promise<SonarAnalysisState | undefined> {
  const resolvedTarget = await resolveTarget(ctx, targetInput);
  try {
    return await loadProjectIssuesFromApi(ctx, targetInput, filters);
  } catch (error) {
    const cached = statesByBaseDir.get(resolvedTarget.baseDir);
    if (cached) return cached;
    throw error;
  }
}

// ── Analysis orchestration ────────────────────────────────────────────────────

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
      ? (analysisUi.setPhase("Waiting for SonarQube analysis..."), await waitForAnalysis(config.serverUrl, config.token, ceTaskUrl, ctx.signal))
      : undefined;

    analysisUi.setPhase("Fetching issues...");
    const normalizedFilters = normalizeIssueFilters(filters);
    const issues = await fetchIssues(config.serverUrl, config.token, config.projectKey, ctx.signal, normalizedFilters);

    const state = createAnalysisState(config, issues, {
      dashboardUrl,
      ceTaskUrl,
      analysisId,
      filters: normalizedFilters,
    });

    pi.appendEntry(STATE_TYPE, state);
    return state;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    analysisUi.stop();
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

async function showIssueBrowser(
  ctx: ExtensionCommandContext,
  state: SonarAnalysisState,
): Promise<number | null> {
  if (ctx.mode !== "tui") return null;
  if (state.issues.length === 0) return null;

  return await ctx.ui.custom<number | null>((_tui, theme, _kb, done) => new IssueBrowser(state, theme, done));
}

async function openIssuePreview(
  ctx: ExtensionCommandContext,
  state: SonarAnalysisState,
  issue: SonarIssue,
): Promise<void> {
  const preview = await buildIssuePreview(state.baseDir, issue);
  const title = `${issue.filePath}${issue.line ? `:${issue.line}` : ""}`;
  if (ctx.mode === "tui") {
    await ctx.ui.editor(title, preview);
    return;
  }
  ctx.ui.notify(`${title}\n${preview}`, "info");
}

// ── Init command ──────────────────────────────────────────────────────────────

interface InitCommandOptions {
  alias?: string;
  targetInput?: string;
}

async function initCommandHandler(ctx: ExtensionCommandContext, options: InitCommandOptions = {}): Promise<void> {
  const { baseDir, repoRoot } = await resolveInitTarget(ctx, options.alias, options.targetInput);
  const existing = await loadProjectConfig(baseDir);

  if (existing) {
    const ok = await ctx.ui.confirm(
      "Overwrite?",
      `SonarQube config already exists at ${baseDir}:\n  Server: ${existing.serverUrl}\n  Project: ${existing.projectKey}\n\nOverwrite?`,
    );
    if (!ok) {
      if (ctx.hasUI) ctx.ui.notify("Init cancelled.", "info");
      return;
    }
  }

  const serverUrlInput = await ctx.ui.editor("SonarQube server URL", existing?.serverUrl ?? "http://localhost:9000");
  if (serverUrlInput === undefined) return;
  const serverUrl = normalizeServerUrl(serverUrlInput || existing?.serverUrl || "http://localhost:9000");

  const projectKeyInput = await ctx.ui.input("SonarQube project key", existing?.projectKey ?? basename(baseDir));
  if (projectKeyInput === undefined) return;
  const projectKey = projectKeyInput || existing?.projectKey || slugify(basename(baseDir));

  const tokenInput = await ctx.ui.input("SonarQube token (optional, press Enter to skip)", existing?.token ?? "");
  if (tokenInput === undefined) return;
  const token = tokenInput.trim() || undefined;

  await saveProjectConfig(baseDir, {
    serverUrl,
    projectKey,
    token,
  });

  const propertiesState = await ensureDefaultSonarProjectProperties(baseDir);

  if (options.alias) {
    await saveWorkspaceRegistry(repoRoot, options.alias, baseDir);
  }

  if (ctx.hasUI) {
    const targetLabel = options.alias ? ` (${options.alias})` : "";
    let propertiesNote = "";
    if (propertiesState === "created") {
      propertiesNote = ` and created ${sonarProjectPropertiesPath(baseDir)}`;
    } else if (propertiesState === "updated") {
      propertiesNote = ` and merged ${sonarProjectPropertiesPath(baseDir)}`;
    }
    ctx.ui.notify(`SonarQube config saved${targetLabel} to ${projectConfigPath(baseDir)}${propertiesNote}`, "info");
  }
}

function helpText(): string {
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

function targetLabel(targetInput?: string): string {
  return targetInput ? ` ${targetInput}` : "";
}

function sonarErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Command arg parsing ───────────────────────────────────────────────────────

type ParsedSonarCommand =
  | { action: "help" }
  | { action: "init"; alias?: string; targetInput?: string }
  | { action: "analyze"; targetInput?: string; filters?: SonarIssueFetchOptions }
  | { action: "issues"; targetInput?: string; filters?: SonarIssueFetchOptions }
  | { action: "open"; targetInput?: string; issueIndex?: number; filters?: SonarIssueFetchOptions };

function parseCommandArgs(args: string): ParsedSonarCommand {
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

// ── Extension entrypoint ──────────────────────────────────────────────────────

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
          const match = beforeCursor.match(/^\/sonarqube(?:\s+(.*))?$/);
          if (!match) {
            return current.getSuggestions(lines, cursorLine, cursorCol, options);
          }

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
          return {
            content: [{ type: "text", text: formatReport(state) }],
            details: state,
          };
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
          content: [{ type: "text", text: `${formatIssue(issue, index)}\n\n${preview}` }],
          details: { ...targetState, selectedIssue: issue },
        };
      } catch (error) {
        const message = sonarErrorMessage(error);
        return { content: [{ type: "text", text: message }], details: { error: message } };
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
      const state =
        result.details as
          | SonarAnalysisState
          | { error?: string; selectedIssue?: SonarIssue }
          | undefined;
      if (state && "error" in state && state.error) {
        return new Text(theme.fg("error", state.error), 0, 0);
      }

      if (state && "selectedIssue" in state && state.selectedIssue) {
        const issue = state.selectedIssue;
        const text = result.content[0]?.type === "text" ? result.content[0].text : formatIssue(issue);
        const preview = expanded ? text.split("\n").slice(1).join("\n") : "";
        return new Text(`${theme.fg("accent", formatIssue(issue))}${preview ? `\n${preview}` : ""}`, 0, 0);
      }

      if (state && "issues" in state) {
        const summary = formatSummary(state);
        if (state.issues.length === 0) {
          return new Text(theme.fg("success", summary), 0, 0);
        }

        const visible = expanded ? state.issues : state.issues.slice(0, 5);
        const lines = [theme.fg("accent", summary)];
        visible.forEach((issue, index) => {
          lines.push(theme.fg("muted", formatIssue(issue, index + 1)));
        });
        if (!expanded && state.issues.length > visible.length) {
          lines.push(theme.fg("dim", `... ${state.issues.length - visible.length} more`));
        }
        return new Text(lines.join("\n"), 0, 0);
      }

      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "", 0, 0);
    },
  });

  pi.registerCommand("sonarqube", {
    description:
      "Run a local SonarQube analysis, browse the latest issues, or init project config",
    getArgumentCompletions: (argumentPrefix) => sonarArgumentCompletions(argumentPrefix, latestState?.issues),
    handler: async (args, ctx) => {
      try {
        const parsed = parseCommandArgs(args);

        // --- Help ---
        if (parsed.action === "help") {
          if (ctx.hasUI) {
            ctx.ui.notify(helpText(), "info");
          }
          return;
        }

        // --- Init ---
        if (parsed.action === "init") {
          await initCommandHandler(ctx, { alias: parsed.alias, targetInput: parsed.targetInput });
          return;
        }

        // --- Analyze ---
        if (parsed.action === "analyze") {
          const state = await analyzeProject(pi, ctx, parsed.targetInput, parsed.filters);
          rememberState(state);
          if (ctx.hasUI) {
            const scope = targetLabel(parsed.targetInput);
            ctx.ui.notify(`${formatSummary(state)}. Use /sonarqube issues${scope} to browse.`, state.issues.length === 0 ? "info" : "warning");
          }
          return;
        }

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

        // --- Issues ---
        if (parsed.action === "issues") {
          if (targetState.issues.length === 0) {
            if (ctx.hasUI) ctx.ui.notify(formatSummary(targetState), "info");
            return;
          }
          const choice = await showIssueBrowser(ctx, targetState);
          if (choice !== null && choice !== undefined) {
            const issue = targetState.issues[choice];
            if (issue) await openIssuePreview(ctx, targetState, issue);
          }
          return;
        }

        // --- Open ---
        const index = parsed.issueIndex ?? 1;
        const issue = targetState.issues[index - 1];
        if (!issue) {
          if (ctx.hasUI) ctx.ui.notify(`Issue #${index} was not found.`, "error");
          return;
        }
        await openIssuePreview(ctx, targetState, issue);
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
