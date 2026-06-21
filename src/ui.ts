import type { Theme, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SonarIssue, SonarAnalysisState, SonarIssueFetchOptions, FileDuplication } from "./types.js";
import { issueFilterLabel, fetchIssues, createAnalysisState, normalizeIssueFilters } from "./api.js";
import { resolveConfig, resolveTarget } from "./config.js";

// ── Issue preview ───────────────────────────────────────────────────────────

export async function buildIssuePreview(baseDir: string, issue: SonarIssue, radius = 3): Promise<string> {
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
}

// ── Analysis UI ─────────────────────────────────────────────────────────────

const ANALYSIS_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const ANALYSIS_WIDGET_KEY = "sonarqube-analysis";

export interface AnalysisUiHandle {
  setPhase(phase: string): void;
  stop(): void;
}

export function startAnalysisUi(ctx: ExtensionContext, projectKey: string): AnalysisUiHandle {
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

// ── Issue Browser UI component ──────────────────────────────────────────────

export class IssueBrowser {
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
    const filterSuffix = this.state.filters ? ` • ${issueFilterLabel(this.state.filters)}` : "";
    const subtitle = this.theme.fg(
      "dim",
      `${this.state.projectKey} • ${this.state.totalIssues} issue(s)${filterSuffix}`,
    );
    lines.push(
      truncateToWidth(title, width),
      truncateToWidth(subtitle, width),
      "",
    );

    const pageSize = Math.min(20, this.state.issues.length);
    const halfWindow = Math.floor(pageSize / 2);
    const maxStart = Math.max(0, this.state.issues.length - pageSize);
    const start = Math.max(0, Math.min(this.selected - halfWindow, maxStart));
    const end = Math.min(this.state.issues.length, start + pageSize);
    const visibleIssues = this.state.issues.slice(start, end);

    if (visibleIssues.length === 0) {
      lines.push(truncateToWidth(this.theme.fg("success", "No open issues found."), width));
      return finalize(lines, width, this.theme, this.cachedWidth, this.cachedLines);
    }

    if (start > 0) {
      lines.push(truncateToWidth(this.theme.fg("dim", `... ${start} more above`), width));
    }
    for (const [offset, issue] of visibleIssues.entries()) {
      const issueIndex = start + offset;
      const isSelected = issueIndex === this.selected;
      const marker = isSelected ? this.theme.fg("accent", ">") : this.theme.fg("dim", " ");
      const location = issue.line ? `${issue.filePath}:${issue.line}` : issue.filePath;
      const rule = issue.ruleName ? `${issue.rule} (${issue.ruleName})` : issue.rule;
      const severity = severityColor(this.theme, issue.severity);
      const summary = [
        marker,
        String(issueIndex + 1).padStart(2, " "),
        ".",
        severity,
        this.theme.fg("accent", location),
        this.theme.fg("muted", rule),
        this.theme.fg("text", `— ${issue.message}`),
      ].join(" ");
      lines.push(truncateToWidth(summary, width));
    }
    if (end < this.state.issues.length) {
      lines.push(
        truncateToWidth(
          this.theme.fg("dim", `... ${this.state.issues.length - end} more below`),
          width,
        ),
      );
    }

    lines.push(
      "",
      truncateToWidth(
        this.theme.fg("dim", "Up/Down to move, Enter to preview, Esc to close"),
        width,
      ),
    );

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

function finalize(
  lines: string[],
  width: number,
  theme: Theme,
  cachedWidth: number | undefined,
  cachedLines: string[] | undefined,
): string[] {
  lines.push(
    "",
    truncateToWidth(theme.fg("dim", "Up/Down to move, Enter to preview, Esc to close"), width),
  );
  const result = cachedLines ?? lines;
  return result;
}

// ── Severity colors ─────────────────────────────────────────────────────────

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

// ── Duplication browser (used by index.ts) ─────────────────────────────────

export class DuplicationBrowser {
  private selected = 0;

  constructor(
    private readonly files: FileDuplication[],
    private readonly theme: Theme,
    private readonly done: (result: number | null) => void,
  ) {}

  invalidate(): void {} // NOSONAR - required by TUI interface

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
      this.done(null);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selected = Math.min(this.files.length - 1, this.selected + 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(this.selected);
    }
  }

  render(width: number): string[] {
    const lines: string[] = [
      this.theme.fg("accent", this.theme.bold(" SonarQube Duplications ")),
      this.theme.fg("dim", `${this.files.length} file(s) with duplicate code`),
      "",
    ];

    const pageSize = Math.min(15, this.files.length);
    const halfWindow = Math.floor(pageSize / 2);
    const maxStart = Math.max(0, this.files.length - pageSize);
    const start = Math.max(0, Math.min(this.selected - halfWindow, maxStart));
    const end = Math.min(this.files.length, start + pageSize);
    const visible = this.files.slice(start, end);

    for (const [offset, file] of visible.entries()) {
      const index = start + offset;
      const isSelected = index === this.selected;
      const marker = isSelected ? this.theme.fg("accent", ">") : this.theme.fg("dim", " ");
      const detail = `blocks=${file.duplicatedBlocks}  lines=${file.duplicatedLines}`;
      const line = `${marker} ${String(index + 1).padStart(2, " ")}. ${this.theme.fg("accent", file.filePath)}  ${this.theme.fg("dim", detail)}`;
      lines.push(truncateToWidth(line, width));
    }

    lines.push(
      "",
      this.theme.fg("dim", "Up/Down to move, Enter for details, Esc to close"),
    );
    return lines;
  }
}

export async function showDuplicationBrowser(
  ctx: ExtensionCommandContext,
  files: FileDuplication[],
): Promise<number | null> {
  if (ctx.mode !== "tui" || files.length === 0) return null;
  return await ctx.ui.custom<number | null>((_tui, theme, _kb, done) => new DuplicationBrowser(files, theme, done));
}

// ── Issue browser / preview helpers (used by index.ts) ──────────────────────

export async function showIssueBrowser(
  ctx: ExtensionCommandContext,
  state: SonarAnalysisState,
): Promise<number | null> {
  if (ctx.mode !== "tui") return null;
  if (state.issues.length === 0) return null;
  return await ctx.ui.custom<number | null>((_tui, theme, _kb, done) => new IssueBrowser(state, theme, done));
}

export async function openIssuePreview(
  ctx: ExtensionCommandContext,
  state: SonarAnalysisState,
  issue: SonarIssue,
): Promise<void> {
  const preview = await buildIssuePreview(state.baseDir, issue);
  const title = issue.line ? `${issue.filePath}:${issue.line}` : issue.filePath;
  if (ctx.mode === "tui") {
    await ctx.ui.editor(title, preview);
    return;
  }
  ctx.ui.notify(`${title}\n${preview}`, "info");
}

// ── Issue loading / target resolution (orchestration) ───────────────────────

export async function loadProjectIssuesFromApi(
  ctx: { signal?: AbortSignal; cwd: string },
  inputPath?: string,
  filters?: SonarIssueFetchOptions,
): Promise<SonarAnalysisState> {
  const config = await resolveConfig(ctx, inputPath);
  const normalizedFilters = normalizeIssueFilters(filters);
  const issues = await fetchIssues(
    config.serverUrl,
    config.token,
    config.projectKey,
    ctx.signal,
    normalizedFilters,
  );
  return createAnalysisState(config, issues, { filters: normalizedFilters });
}

export async function resolveTargetState(
  ctx: { signal?: AbortSignal; cwd: string },
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
