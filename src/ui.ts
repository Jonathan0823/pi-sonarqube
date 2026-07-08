import type {
  Theme,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";
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

// ── Searchable browser helpers ─────────────────────────────────────────────

function normalizeSearchQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchesSearchQuery(haystack: string, query: string): boolean {
  const tokens = normalizeSearchQuery(query);
  if (tokens.length === 0) return true;
  const text = haystack.toLowerCase();
  return tokens.every((token) => text.includes(token));
}

function filterSearchItems<T>(
  items: readonly T[],
  query: string,
  searchText: (item: T) => string,
): T[] {
  if (!query.trim()) return [...items];
  return items.filter((item) => matchesSearchQuery(searchText(item), query));
}

interface SearchableBrowserConfig<T> {
  title: string;
  subtitle: (query: string, totalCount: number, filteredCount: number) => string;
  searchHint: string;
  emptyMessage: string;
  footer: string;
  pageSize: number;
  searchText: (item: T) => string;
  renderItem: (item: T, index: number, isSelected: boolean) => string;
}

class SearchableListBrowser<T> implements Focusable {
  private selected = 0;
  private query = "";
  private filteredItems: T[];
  private _focused = false;
  private readonly searchInput = new Input();

  constructor(
    private readonly items: readonly T[],
    private readonly theme: Theme,
    private readonly done: (result: number | null) => void,
    private readonly config: SearchableBrowserConfig<T>,
  ) {
    this.filteredItems = [...items];
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

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
      this.selected = Math.min(
        Math.max(0, this.filteredItems.length - 1),
        this.selected + 1,
      );
      return;
    }

    if (matchesKey(data, Key.enter)) {
      if (this.filteredItems.length > 0) this.done(this.selected);
      return;
    }

    this.searchInput.handleInput(data);
    this.syncFilter();
  }

  render(width: number): string[] {
    const subtitle = this.config.subtitle(
      this.query,
      this.items.length,
      this.filteredItems.length,
    );
    return [
      truncateToWidth(this.theme.fg("dim", this.config.searchHint), width),
      ...this.searchInput.render(width),
      "",
      ...renderListBrowser(this.theme, width, {
        title: this.config.title,
        subtitle,
        items: this.filteredItems,
        selected: this.selected,
        pageSize: this.config.pageSize,
        emptyMessage: this.config.emptyMessage,
        footer: this.config.footer,
        renderItem: this.config.renderItem,
      }),
    ];
  }

  private syncFilter(): void {
    const nextQuery = this.searchInput.getValue();
    if (nextQuery === this.query) return;
    this.query = nextQuery;
    this.filteredItems = filterSearchItems(
      this.items,
      nextQuery,
      this.config.searchText,
    );
    this.selected = 0;
  }
}

export class IssueBrowser extends SearchableListBrowser<SonarIssue> {
  constructor(
    state: SonarAnalysisState,
    theme: Theme,
    done: (result: number | null) => void,
  ) {
    const filterSuffix = state.filters ? ` • ${issueFilterLabel(state.filters)}` : "";
    super(state.issues, theme, done, {
      title: "SonarQube Issues",
      subtitle: (_query, totalCount, filteredCount) =>
        `${state.projectKey} • ${totalCount} issue(s) • ${filteredCount} match(es)${filterSuffix}`,
      searchHint: "Search issues by file, rule, severity, status, or message",
      emptyMessage: "No matching issues found.",
      footer: "Up/Down to move, Enter to preview, Esc to close",
      pageSize: 20,
      searchText: (issue) =>
        [
          issue.filePath,
          issue.rule,
          issue.ruleName ?? "",
          issue.severity,
          issue.status ?? "",
          issue.message,
        ].join(" "),
      renderItem: (issue, issueIndex, isSelected) => {
        const marker = isSelected
          ? theme.fg("accent", ">")
          : theme.fg("dim", " ");
        const location = issue.line ? `${issue.filePath}:${issue.line}` : issue.filePath;
        const rule = issue.ruleName
          ? `${issue.rule} (${issue.ruleName})`
          : issue.rule;
        const severity = severityColor(theme, issue.severity);
        return [
          marker,
          String(issueIndex + 1).padStart(2, " "),
          ".",
          severity,
          theme.fg("accent", location),
          theme.fg("muted", rule),
          theme.fg("text", `— ${issue.message}`),
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

export class DuplicationBrowser extends SearchableListBrowser<FileDuplication> {
  constructor(
    files: FileDuplication[],
    theme: Theme,
    done: (result: number | null) => void,
  ) {
    super(files, theme, done, {
      title: "SonarQube Duplications",
      subtitle: (_query, totalCount, filteredCount) =>
        `${totalCount} file(s) with duplicate code • ${filteredCount} match(es)`,
      searchHint: "Search duplications by file path, duplicated lines, blocks, or density",
      emptyMessage: "No matching duplicated files found.",
      footer: "Up/Down to move, Enter for details, Esc to close",
      pageSize: 15,
      searchText: (file) =>
        [
          file.filePath,
          `dup%=${file.duplicatedLinesDensity.toFixed(1)}`,
          `blocks=${file.duplicatedBlocks}`,
          `lines=${file.duplicatedLines}`,
        ].join(" "),
      renderItem: (file, index, isSelected) => {
        const marker = isSelected
          ? theme.fg("accent", ">")
          : theme.fg("dim", " ");
        const detail = `dup%=${file.duplicatedLinesDensity.toFixed(1)}  blocks=${file.duplicatedBlocks}  lines=${file.duplicatedLines}`;
        return `${marker} ${String(index + 1).padStart(2, " ")}. ${theme.fg("accent", file.filePath)}  ${theme.fg("dim", detail)}`;
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
    config.baseDir,
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
