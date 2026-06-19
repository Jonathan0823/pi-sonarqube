import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
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
});

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
  return Object.keys(registry.workspaces).sort();
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
  return noIssues
    ? `SonarQube: no issues found for ${state.projectKey}`
    : `SonarQube: ${issueCount} issue${issueCount === 1 ? "" : "s"} found for ${state.projectKey}`;
}

function formatReport(state: SonarAnalysisState): string {
  const lines = [
    `Project: ${state.projectKey}`,
    `Server: ${state.serverUrl}`,
    `Base dir: ${state.baseDir}`,
    `Issues: ${state.totalIssues}`,
  ];

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
    const subtitle = this.theme.fg("dim", `${this.state.projectKey} • ${this.state.totalIssues} issue(s)`);
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

  if (latest) {
    ctx.ui.setStatus("sonarqube", formatSummary(latest));
  }

  return latest;
}

// ── Error hints ───────────────────────────────────────────────────────────────

function extractScannerHint(output: string, config: SonarProjectConfig): string {
  const lines = output.toLowerCase();

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
    const hint = extractScannerHint(output, config);
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
): Promise<SonarIssue[]> {
  const issues: SonarIssue[] = [];
  const ruleNames = new Map<string, string | undefined>();
  let page = 1;
  let total = 0;

  for (;;) {
    const url = `${serverUrl}/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&resolved=false&ps=100&p=${page}`;
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
    }>(url, token, signal);

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

  return issues;
}

function createAnalysisState(
  config: Pick<SonarProjectConfig, "baseDir" | "serverUrl" | "projectKey">,
  issues: SonarIssue[],
  extras: Partial<Pick<SonarAnalysisState, "dashboardUrl" | "ceTaskUrl" | "analysisId">> = {},
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
): Promise<SonarAnalysisState> {
  const config = await resolveConfig(ctx, inputPath);
  const issues = await fetchIssues(config.serverUrl, config.token, config.projectKey, ctx.signal);
  return createAnalysisState(config, issues);
}

async function resolveTargetState(
  ctx: ExtensionContext,
  statesByBaseDir: Map<string, SonarAnalysisState>,
  targetInput?: string,
): Promise<SonarAnalysisState | undefined> {
  const resolvedTarget = await resolveTarget(ctx, targetInput);
  try {
    return await loadProjectIssuesFromApi(ctx, targetInput);
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
): Promise<SonarAnalysisState> {
  const config = await resolveConfig(ctx, inputPath);
  const baseDirStat = await stat(config.baseDir).catch(() => undefined);
  if (!baseDirStat?.isDirectory()) {
    throw new Error(`Project directory not found: ${config.baseDir}`);
  }

  ctx.ui.setWorkingMessage(`Running SonarQube analysis for ${config.projectKey}`);
  ctx.ui.setWorkingIndicator({
    frames: [".", "..", "...", ".."],
    intervalMs: 180,
  });
  ctx.ui.setStatus("sonarqube", `Analyzing ${config.projectKey}`);

  try {
    await runScanner(pi, config, ctx.signal);
    const report = await readReportTask(config.baseDir);
    const ceTaskUrl = report["ceTaskUrl"];
    const dashboardUrl = report["dashboardUrl"];
    const analysisId = ceTaskUrl
      ? await waitForAnalysis(config.serverUrl, config.token, ceTaskUrl, ctx.signal)
      : undefined;
    const issues = await fetchIssues(config.serverUrl, config.token, config.projectKey, ctx.signal);

    const state = createAnalysisState(config, issues, {
      dashboardUrl,
      ceTaskUrl,
      analysisId,
    });

    pi.appendEntry(STATE_TYPE, state);
    ctx.ui.setStatus("sonarqube", formatSummary(state));
    return state;
  } catch (error) {
    ctx.ui.setStatus("sonarqube", undefined);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
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
  ctx.ui.setStatus("sonarqube", title);
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

  if (options.alias) {
    await saveWorkspaceRegistry(repoRoot, options.alias, baseDir);
  }

  if (ctx.hasUI) {
    const targetLabel = options.alias ? ` (${options.alias})` : "";
    ctx.ui.notify(`SonarQube config saved${targetLabel} to ${projectConfigPath(baseDir)}`, "info");
  }
}

function helpText(): string {
  return [
    "SonarQube commands:",
    "",
    "  /sonarqube init [alias] [path]   configure target and optional alias",
    "  /sonarqube analyze [target]      run analysis for alias or path",
    "  /sonarqube issues [target]       browse latest issues for target",
    "  /sonarqube open [target] <n>     preview issue #n for target",
    "  /sonarqube                       show this help",
    "",
    "Defaults:",
    "  config is stored in .pi/sonarqube.json",
    "  monorepo aliases live in .pi/sonarqube.workspaces.json",
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
  | { action: "analyze"; targetInput?: string }
  | { action: "issues"; targetInput?: string }
  | { action: "open"; targetInput?: string; issueIndex?: number };

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
    return { action: "issues", targetInput: tokens[1] };
  }
  if (head === "open") {
    if (tokens.length === 2 && /^\d+$/.test(tokens[1])) {
      return { action: "open", issueIndex: Number(tokens[1]) };
    }
    const targetInput = tokens[1];
    const maybeIndex = tokens[2];
    return {
      action: "open",
      targetInput,
      issueIndex: maybeIndex && /^\d+$/.test(maybeIndex) ? Number(maybeIndex) : undefined,
    };
  }
  if (head === "analyze" || head === "run") {
    return { action: "analyze", targetInput: tokens[1] };
  }

  return { action: "analyze", targetInput: tokens[0] };
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
    ],
    parameters: SonarToolParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        if (params.action === "analyze") {
          const state = await analyzeProject(pi, ctx, params.path);
          rememberState(state);
          return {
            content: [{ type: "text", text: formatReport(state) }],
            details: state,
          };
        }

        const targetState = await resolveTargetState(ctx, statesByBaseDir, params.path);
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
      return new Text(
        `${theme.fg("toolTitle", theme.bold("sonarqube"))} ${theme.fg("muted", args.action)}${
          args.path ? ` ${theme.fg("accent", args.path)}` : ""
        }`,
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
          const state = await analyzeProject(pi, ctx, parsed.targetInput);
          rememberState(state);
          if (ctx.hasUI) {
            const scope = targetLabel(parsed.targetInput);
            ctx.ui.notify(`${formatSummary(state)}. Use /sonarqube issues${scope} to browse.`, state.issues.length === 0 ? "info" : "warning");
          }
          return;
        }

        const targetState = await resolveTargetState(ctx, statesByBaseDir, parsed.targetInput);
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
