import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  SonarIssue,
  SonarAnalysisState,
  SonarProjectConfig,
  SonarIssueFetchOptions,
} from "./types.js";
import { SONAR_SEVERITIES, SONAR_STATUSES, SONAR_TYPES } from "./types.js";
import { parseProperties } from "./config.js";

// ── Auth / HTTP helpers ─────────────────────────────────────────────────────

export function authHeader(token?: string): string | undefined {
  if (!token) return undefined;
  const credentials = `${token}:`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

export async function fetchJson<T>(url: string, token?: string, signal?: AbortSignal): Promise<T> {
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

export function toIssuePath(component: string, projectKey: string): string {
  const prefix = `${projectKey}:`;
  if (component.startsWith(prefix)) return component.slice(prefix.length);
  const colon = component.indexOf(":");
  return colon >= 0 ? component.slice(colon + 1) : component;
}

// ── Issue filter helpers ────────────────────────────────────────────────────

export function normalizeIssueList(values?: string[], uppercase = false): string[] | undefined {
  const cleaned = values
    ?.map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (uppercase ? v.toUpperCase() : v));
  if (!cleaned?.length) return undefined;
  return [...new Set(cleaned)];
}

export function normalizeIssueFilters(filters?: SonarIssueFetchOptions): SonarIssueFetchOptions | undefined {
  const normalized = {
    severities: normalizeIssueList(filters?.severities, true),
    statuses: normalizeIssueList(filters?.statuses, true),
    types: normalizeIssueList(filters?.types, true),
    rules: normalizeIssueList(filters?.rules),
  };
  return normalized.severities || normalized.statuses || normalized.types || normalized.rules ? normalized : undefined;
}

export function mergeIssueFilters(
  ...filters: Array<Partial<SonarIssueFetchOptions> | undefined>
): SonarIssueFetchOptions | undefined {
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

export function splitFilterValues(value: string): string[] {
  return value.split(",").map((p) => p.trim()).filter(Boolean);
}

const EXPLICIT_FILTER_RE = /^([^:=]+)[:=](.+)$/;

export function parseIssueFilterToken(token: string): Partial<SonarIssueFetchOptions> | undefined {
  const trimmed = token.trim();
  if (!trimmed) return undefined;

  const explicit = EXPLICIT_FILTER_RE.exec(trimmed);
  if (explicit) {
    const key = explicit[1].trim().toLowerCase();
    const values = splitFilterValues(explicit[2]);
    if (values.length === 0) return undefined;

    if (key === "severity" || key === "severities") return { severities: values.map((v) => v.toUpperCase()) };
    if (key === "status" || key === "statuses") return { statuses: values.map((v) => v.toUpperCase()) };
    if (key === "type" || key === "types") return { types: values.map((v) => v.toUpperCase()) };
    if (key === "rule" || key === "rules") return { rules: values };
    return undefined;
  }

  const upper = trimmed.toUpperCase();
  if (SONAR_SEVERITIES.includes(upper as (typeof SONAR_SEVERITIES)[number])) return { severities: [upper] };
  if (SONAR_STATUSES.includes(upper as (typeof SONAR_STATUSES)[number])) return { statuses: [upper] };
  if (SONAR_TYPES.includes(upper as (typeof SONAR_TYPES)[number])) return { types: [upper] };
  return undefined;
}

export function parseSonarIssueArgs(
  tokens: string[],
  allowIssueIndex = false,
): { targetInput?: string; issueIndex?: number; filters?: SonarIssueFetchOptions } {
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

  return { targetInput, issueIndex, filters: mergeIssueFilters(...filters) };
}

export function issueFilterLabel(filters?: SonarIssueFetchOptions): string {
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

// ── Error hints ─────────────────────────────────────────────────────────────

export function sonarScannerInstallHint(): string {
  return [
    "SonarScanner is not installed or not on PATH.",
    "Please install SonarScanner and make sure `sonar-scanner` is available, then retry.",
  ].join(" ");
}

export function extractScannerHint(output: string, config: SonarProjectConfig, exitCode?: number): string {
  const lines = output.toLowerCase();

  const isNotFoundOnPath =
    exitCode === 127 ||
    /spawn .*enoent|enoent|command not found|is not recognized/i.test(lines);
  if (isNotFoundOnPath) {
    return sonarScannerInstallHint();
  }

  const isUnauthorized = /status code 401|status 401|unauthorized/i.test(lines);
  if (isUnauthorized) {
    const defaultHint = config.serverUrl === "http://localhost:9000" ? " (default: http://localhost:9000)" : "";
    return [
      `Authentication failed for ${config.serverUrl}${defaultHint}.`,
      "Run `/sonarqube init` to set up your server URL and token, then retry.",
      "Or set SONARQUBE_TOKEN in your environment.",
    ].join(" ");
  }

  const isForbidden = /status code 403|status 403|forbidden/i.test(lines);
  if (isForbidden) {
    return [
      `Access denied by ${config.serverUrl}.`,
      'Your token may not have the required permissions ("Execute Analysis").',
      "Run `/sonarqube init` to update the token or check server permissions.",
    ].join(" ");
  }

  const isConnectionError = /connect econnrefused|connect refused|connect timeout|enotfound|econnreset/i.test(lines);
  if (isConnectionError) {
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

// ── Scanner interaction ─────────────────────────────────────────────────────

export async function runScanner(pi: ExtensionAPI, config: SonarProjectConfig, signal?: AbortSignal): Promise<string> {
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

export async function readReportTask(baseDir: string): Promise<Record<string, string>> {
  const path = resolve(baseDir, ".scannerwork", "report-task.txt");
  const text = await readFile(path, "utf8");
  return parseProperties(text);
}

export async function waitForAnalysis(
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
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for SonarQube analysis at ${serverUrl}`);
}

// ── Issue fetching ──────────────────────────────────────────────────────────

function buildIssueSearchUrl(
  serverUrl: string,
  projectKey: string,
  page: number,
  filters?: SonarIssueFetchOptions,
): string {
  const url = new URL("/api/issues/search", serverUrl);
  url.searchParams.set("projects", projectKey);
  url.searchParams.set("resolved", "false");
  url.searchParams.set("ps", "100");
  url.searchParams.set("p", String(page));
  if (filters?.severities?.length) url.searchParams.set("severities", filters.severities.join(","));
  if (filters?.statuses?.length) url.searchParams.set("statuses", filters.statuses.join(","));
  if (filters?.types?.length) url.searchParams.set("types", filters.types.join(","));
  if (filters?.rules?.length) url.searchParams.set("rules", filters.rules.join(","));
  return url.toString();
}

function mapRawIssue(
  raw: {
    key: string;
    rule: string;
    severity: string;
    message: string;
    component: string;
    line?: number;
    status?: string;
  },
  projectKey: string,
  ruleNames: Map<string, string | undefined>,
): SonarIssue {
  return {
    key: raw.key,
    rule: raw.rule,
    ruleName: ruleNames.get(raw.rule),
    severity: raw.severity,
    message: raw.message,
    filePath: toIssuePath(raw.component, projectKey),
    line: typeof raw.line === "number" ? raw.line : null,
    status: raw.status,
  };
}

export async function fetchIssuePage(
  serverUrl: string,
  token: string | undefined,
  projectKey: string,
  page: number,
  signal?: AbortSignal,
  filters?: SonarIssueFetchOptions,
): Promise<{ total: number; issueRows: Array<{ key: string; rule: string; severity: string; message: string; component: string; line?: number; status?: string }> }> {
  const url = buildIssueSearchUrl(serverUrl, projectKey, page, filters);
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
  return { total: result.total, issueRows: result.issues };
}

export async function fetchIssues(
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
    const { total: pageTotal, issueRows } = await fetchIssuePage(
      serverUrl, token, projectKey, page, signal, normalizedFilters,
    );
    total = pageTotal;

    for (const raw of issueRows) {
      if (!ruleNames.has(raw.rule)) {
        ruleNames.set(raw.rule, await fetchRuleName(serverUrl, token, raw.rule, signal));
      }
      issues.push(mapRawIssue(raw, projectKey, ruleNames));
    }

    if (issues.length >= total || issueRows.length === 0) break;
    page += 1;
  }

  if (normalizedFilters && issues.length > 1) {
    issues.sort(compareIssuesForContext);
  }

  return issues;
}

export async function fetchRuleName(
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

// ── Analysis state ──────────────────────────────────────────────────────────

export function createAnalysisState(
  config: Pick<SonarProjectConfig, "baseDir" | "serverUrl" | "projectKey">,
  issues: SonarIssue[],
  extras: Partial<Pick<SonarAnalysisState, "dashboardUrl" | "ceTaskUrl" | "analysisId" | "filters">> = {},
): SonarAnalysisState {
  return {
    version: 1,
    analyzedAt: new Date().toISOString(),
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

export async function hasProjectAnalyses(
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
