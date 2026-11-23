import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  SonarIssue,
  SonarAnalysisState,
  SonarIssueFetchOptions,
  DuplicationBlockGroup,
  SessionStateStore,
} from "./types.js";
import {
  fetchIssues,
  createAnalysisState,
  normalizeIssueFilters,
  fetchCleanCodeMode,
} from "./api.js";
import { formatIssue, sonarErrorMessage } from "./commands.js";
import { resolveConfig, resolveTarget, type ResolveCtx } from "./config.js";

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
  display: (path: string) => string = (path) => path,
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

  const rendered: string[] = [`Duplications in ${display(filePath)}`];
  type Block = DuplicationBlockGroup["blocks"][number];
  const range = (block: Block) =>
    `${display(block.filePath)}:${block.from}-${block.from + block.size - 1}`;
  /** First copy whose source can be read, with its rendered lines. */
  const firstReadableBlock = async (blocks: Block[]) => {
    for (const [index, block] of blocks.entries()) {
      try {
        const lines = await loadLines(block.filePath); // NOSONAR: first readable copy wins.
        return { index, lines: renderRange(lines, block.from, block.size) };
      } catch {
        // try the next copy
      }
    }
    return undefined;
  };

  for (const [groupIndex, group] of groups.entries()) {
    rendered.push("", `Block ${groupIndex + 1}:`);
    const readable = await firstReadableBlock(group.blocks); // NOSONAR: groups render in order.
    if (readable) {
      rendered.push(`  ${range(group.blocks[readable.index])}`);
      for (const line of readable.lines) rendered.push(`  ${line}`);
    } else if (group.blocks.length > 0) {
      rendered.push("  <unable to read duplicated lines>");
    }
    const others = group.blocks.filter((_, i) => i !== readable?.index);
    if (others.length > 0) {
      rendered.push(`  also: ${others.map(range).join(", ")}`);
    }
  }
  return rendered.join("\n");
}

// ── Analysis UI ─────────────────────────────────────────────────────────────

export async function buildIssueKeyPreviews(
  baseDir: string,
  issueKeys: string[],
  issues: SonarIssue[],
): Promise<{
  text: string;
  selectedIssues: SonarIssue[];
  missingIssueKeys: string[];
}> {
  const issuesByKey = new Map(issues.map((issue) => [issue.key, issue]));
  const selectedIssues: SonarIssue[] = [];
  const missingIssueKeys: string[] = [];
  const sections = await Promise.all(
    issueKeys.map(async (key) => {
      const issue = issuesByKey.get(key);
      if (!issue) {
        missingIssueKeys.push(key);
        return `Issue key "${key}" was not found.`;
      }
      selectedIssues.push(issue);
      try {
        const preview = await buildIssuePreview(baseDir, issue);
        return `${formatIssue(issue)}\n\n${preview}`;
      } catch (error) {
        return `${formatIssue(issue)}\n\n${sonarErrorMessage(error)}`;
      }
    }),
  );
  return { text: sections.join("\n\n"), selectedIssues, missingIssueKeys };
}
// ── Issue loading / target resolution ───────────────────────────────────────

export async function loadProjectIssuesFromApi(
  ctx: ResolveCtx,
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
  ctx: ResolveCtx,
  store: Pick<SessionStateStore, "get">,
  targetInput?: string,
  filters?: SonarIssueFetchOptions,
): Promise<SonarAnalysisState | undefined> {
  const resolvedTarget = await resolveTarget(ctx, targetInput);
  try {
    return await loadProjectIssuesFromApi(ctx, targetInput, filters);
  } catch (error) {
    const cached = store.get(resolvedTarget.baseDir);
    const httpFailure = sonarErrorMessage(error).includes(
      "SonarQube API request failed",
    );
    const sameFilters =
      JSON.stringify(normalizeIssueFilters(cached?.filters)) ===
      JSON.stringify(normalizeIssueFilters(filters));
    if (cached && !httpFailure && sameFilters) return cached;
    throw error;
  }
}
