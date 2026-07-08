import type {
  Theme,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  SonarIssue,
  SonarAnalysisState,
  SonarIssueFetchOptions,
  FileDuplication,
  DuplicationBlockGroup,
} from "./types.js";
import {
  issueFilterLabel,
  fetchIssues,
  createAnalysisState,
  normalizeIssueFilters,
  fetchCleanCodeMode,
} from "./api.js";
import { resolveConfig, resolveTarget } from "./config.js";

// ── Issue preview ───────────────────────────────────────────────────────────

export async function buildIssuePreview(
  baseDir: string,
  issue: SonarIssue,
  radius = 3,
): Promise<string> {
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

export async function buildDuplicationPreview(
  baseDir: string,
  filePath: string,
  groups: DuplicationBlockGroup[],
): Promise<string> {
  const cache = new Map<string, string>();
  const loadLines = async (relativePath: string): Promise<string[]> => {
    const absolutePath = resolve(baseDir, relativePath);
    const cached = cache.get(absolutePath);
    if (cached !== undefined) return cached.split(/\r?\n/);
    const content = await readFile(absolutePath, "utf8");
    cache.set(absolutePath, content);
    return content.split(/\r?\n/);
  };
  const renderRange = (
    lines: string[],
    from: number,
    size: number,
  ): string[] => {
    const start = Math.max(1, from);
    const end = Math.min(lines.length, from + size - 1);
    const width = String(end).length;
    const rendered: string[] = [];
    for (let line = start; line <= end; line++) {
      const num = String(line).padStart(width, " ");
      rendered.push(`${num} | ${lines[line - 1] ?? ""}`);
    }
    return rendered;
  };

  const rendered: string[] = [`Duplications in ${filePath}`];
  for (const [groupIndex, group] of groups.entries()) {
    rendered.push("", `Block ${groupIndex + 1}:`);
    for (const block of group.blocks) {
      try {
        const lines = await loadLines(block.filePath);
        const end = block.from + block.size - 1;
        rendered.push(`  ${block.filePath}:${block.from}-${end}`);
        for (const line of renderRange(lines, block.from, block.size)) {
          rendered.push(`  ${line}`);
        }
      } catch {
        rendered.push(
          `  ${block.filePath}:${block.from}-${block.from + block.size - 1}`,
          "  <unable to read duplicated lines>",
        );
      }
    }
  }
  return rendered.join("\n");
}

// ── Analysis UI ─────────────────────────────────────────────────────────────

const ANALYSIS_SPINNER = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
const ANALYSIS_WIDGET_KEY = "sonarqube-analysis";

export interface AnalysisUiHandle {
  setPhase(phase: string): void;
  stop(): void;
}

export function startAnalysisUi(
  ctx: ExtensionContext,
  projectKey: string,
): AnalysisUiHandle {
  let frameIndex = 0;
  let phase = "Starting...";
  const render = () => {
    const frame = ANALYSIS_SPINNER[frameIndex];
    ctx.ui.setWidget(ANALYSIS_WIDGET_KEY, [
      `${frame} SonarQube ${projectKey}`,
      phase,
    ]);
  };

  ctx.ui.setWorkingMessage(`Analyzing ${projectKey}...`);
  ctx.ui.setWorkingIndicator({
    frames: ANALYSIS_SPINNER as unknown as string[],
    intervalMs: 80,
  });
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

  constructor(
    private readonly state: SonarAnalysisState,
    private readonly theme: Theme,
    private readonly done: (result: number | null) => void,
  ) {}

  invalidate(): void {} // NOSONAR - required by TUI interface

  handleInput(data: string): void {
    this.selected = handleListBrowserInput(
      data,
      this.selected,
      this.state.issues.length,
      this.done,
    );
  }

  render(width: number): string[] {
    const filterSuffix = this.state.filters
      ? ` • ${issueFilterLabel(this.state.filters)}`
      : "";
    return renderListBrowser(this.theme, width, {
      title: "SonarQube Issues",
      subtitle: `${this.state.projectKey} • ${this.state.totalIssues} issue(s)${filterSuffix}`,
      items: this.state.issues,
      selected: this.selected,
      pageSize: 20,
      emptyMessage: "No open issues found.",
      footer: "Up/Down to move, Enter to preview, Esc to close",
      renderItem: (issue, issueIndex, isSelected) => {
        const marker = isSelected
          ? this.theme.fg("accent", ">")
          : this.theme.fg("dim", " ");
        const location = issue.line
          ? `${issue.filePath}:${issue.line}`
          : issue.filePath;
        const rule = issue.ruleName
          ? `${issue.rule} (${issue.ruleName})`
          : issue.rule;
        const severity = severityColor(this.theme, issue.severity);
        return [
          marker,
          String(issueIndex + 1).padStart(2, " "),
          ".",
          severity,
          this.theme.fg("accent", location),
          this.theme.fg("muted", rule),
          this.theme.fg("text", `— ${issue.message}`),
        ].join(" ");
      },
    });
  }
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

function handleListBrowserInput(
  data: string,
  selected: number,
  count: number,
  done: (result: number | null) => void,
): number {
  if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
    done(null);
    return selected;
  }
  if (matchesKey(data, Key.up)) {
    return Math.max(0, selected - 1);
  }
  if (matchesKey(data, Key.down)) {
    return Math.min(Math.max(0, count - 1), selected + 1);
  }
  if (matchesKey(data, Key.enter)) {
    done(selected);
  }
  return selected;
}

function getBrowserWindow(
  selected: number,
  total: number,
  pageSize: number,
): { start: number; end: number } {
  const halfWindow = Math.floor(pageSize / 2);
  const maxStart = Math.max(0, total - pageSize);
  const start = Math.max(0, Math.min(selected - halfWindow, maxStart));
  const end = Math.min(total, start + pageSize);
  return { start, end };
}

interface ListBrowserRenderConfig<T> {
  title: string;
  subtitle: string;
  items: readonly T[];
  selected: number;
  pageSize: number;
  emptyMessage: string;
  footer: string;
  renderItem: (item: T, index: number, isSelected: boolean) => string;
}

function renderListBrowser<T>(
  theme: Theme,
  width: number,
  config: ListBrowserRenderConfig<T>,
): string[] {
  const lines: string[] = [
    truncateToWidth(theme.fg("accent", theme.bold(` ${config.title} `)), width),
    truncateToWidth(theme.fg("dim", config.subtitle), width),
    "",
  ];

  const pageSize = Math.min(config.pageSize, config.items.length);
  const { start, end } = getBrowserWindow(
    config.selected,
    config.items.length,
    pageSize,
  );
  const visible = config.items.slice(start, end);

  if (visible.length === 0) {
    lines.push(
      truncateToWidth(theme.fg("success", config.emptyMessage), width),
      "",
      truncateToWidth(theme.fg("dim", config.footer), width),
    );
    return lines;
  }

  if (start > 0) {
    lines.push(
      truncateToWidth(theme.fg("dim", `... ${start} more above`), width),
    );
  }
  for (const [offset, item] of visible.entries()) {
    const index = start + offset;
    lines.push(
      truncateToWidth(
        config.renderItem(item, index, index === config.selected),
        width,
      ),
    );
  }
  if (end < config.items.length) {
    lines.push(
      truncateToWidth(
        theme.fg("dim", `... ${config.items.length - end} more below`),
        width,
      ),
    );
  }

  lines.push("", truncateToWidth(theme.fg("dim", config.footer), width));
  return lines;
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
    this.selected = handleListBrowserInput(
      data,
      this.selected,
      this.files.length,
      this.done,
    );
  }

  render(width: number): string[] {
    return renderListBrowser(this.theme, width, {
      title: "SonarQube Duplications",
      subtitle: `${this.files.length} file(s) with duplicate code`,
      items: this.files,
      selected: this.selected,
      pageSize: 15,
      emptyMessage: "No duplicate code found.",
      footer: "Up/Down to move, Enter for details, Esc to close",
      renderItem: (file, index, isSelected) => {
        const marker = isSelected
          ? this.theme.fg("accent", ">")
          : this.theme.fg("dim", " ");
        const detail = `dup%=${file.duplicatedLinesDensity.toFixed(1)}  blocks=${file.duplicatedBlocks}  lines=${file.duplicatedLines}`;
        return `${marker} ${String(index + 1).padStart(2, " ")}. ${this.theme.fg("accent", file.filePath)}  ${this.theme.fg("dim", detail)}`;
      },
    });
  }
}

export async function showDuplicationBrowser(
  ctx: ExtensionCommandContext,
  files: FileDuplication[],
): Promise<number | null> {
  if (ctx.mode !== "tui" || files.length === 0) return null;
  return await ctx.ui.custom<number | null>(
    (_tui, theme, _kb, done) => new DuplicationBrowser(files, theme, done),
  );
}

// ── Issue browser / preview helpers (used by index.ts) ──────────────────────

export async function showIssueBrowser(
  ctx: ExtensionCommandContext,
  state: SonarAnalysisState,
): Promise<number | null> {
  if (ctx.mode !== "tui") return null;
  if (state.issues.length === 0) return null;
  return await ctx.ui.custom<number | null>(
    (_tui, theme, _kb, done) => new IssueBrowser(state, theme, done),
  );
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
  const cleanCodeMode = await fetchCleanCodeMode(
    config.serverUrl,
    config.token,
    ctx.signal,
  );
  return createAnalysisState(config, issues, {
    filters: normalizedFilters,
    cleanCodeMode,
  });
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
