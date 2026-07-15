import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import type {
  SonarInitConfig,
  SonarProjectConfig,
  SonarWorkspaceRegistry,
  ResolvedTarget,
} from "./types.js";

// ── Generic helpers ─────────────────────────────────────────────────────────

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "sonarqube"
  );
}

export function normalizePath(input: string, cwd: string): string {
  const trimmed = input.trim().replace(/^@/, "");
  return resolve(cwd, trimmed);
}

export function parseProperties(text: string): Record<string, string> {
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

export function normalizeServerUrl(url: string | undefined): string {
  const fallback = "http://localhost:9000";
  if (!url?.trim()) return fallback;
  return url.trim().replace(/\/+$/, "");
}

export function resolveProjectKey(
  baseDir: string,
  props: Record<string, string>,
): string {
  const fromProps = props["sonar.projectKey"]?.trim();
  if (fromProps) return fromProps;
  return slugify(basename(baseDir));
}

// ── File helpers ────────────────────────────────────────────────────────────

export async function readOptionalText(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function readOptionalJson<T>(
  path: string,
): Promise<T | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

// ── Config file paths ───────────────────────────────────────────────────────

export function projectConfigPath(baseDir: string): string {
  return resolve(baseDir, CONFIG_DIR_NAME, "sonarqube.json");
}

export function sonarqubeConfigDir(baseDir: string): string {
  return resolve(baseDir, CONFIG_DIR_NAME);
}

export function sonarProjectPropertiesPath(baseDir: string): string {
  return resolve(baseDir, "sonar-project.properties");
}

// ── Default sonar-project.properties ────────────────────────────────────────

export const DEFAULT_SONAR_EXCLUSIONS = [
  "**/node_modules/**",
  "dist/**",
  "coverage/**",
  ".scannerwork/**",
  "**/.env*",
  ".next/**",
  ".pi/**",
  "build/**",
  "out/**",
  ".turbo/**",
  ".vercel/**",
];

const DEFAULT_SONAR_PROJECT_PROPERTIES =
  [
    "sonar.sources=.",
    `sonar.exclusions=${DEFAULT_SONAR_EXCLUSIONS.join(",")}`,
  ].join("\n") + "\n";

export function mergeCommaSeparatedValues(
  existingValue: string | undefined,
  additions: string[],
): string {
  const merged = new Set(
    (existingValue ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
  for (const addition of additions) {
    const trimmed = addition.trim();
    if (trimmed) merged.add(trimmed);
  }
  return [...merged].join(",");
}

const EXCLUSION_RE = /^(\s*)(sonar\.(?:sources|exclusions))\s*=\s*(.*)$/;

export async function ensureDefaultSonarProjectProperties(
  baseDir: string,
): Promise<"created" | "updated" | "unchanged"> {
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
    const match = EXCLUSION_RE.exec(line);
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
  return existing.includes("sonar.sources") ||
    existing.includes("sonar.exclusions")
    ? "updated"
    : "created";
}

// ── Config load/save ────────────────────────────────────────────────────────

export async function loadProjectConfig(
  baseDir: string,
): Promise<SonarInitConfig | undefined> {
  return readOptionalJson<SonarInitConfig>(projectConfigPath(baseDir));
}

export async function saveProjectConfig(
  baseDir: string,
  config: SonarInitConfig,
): Promise<void> {
  const dir = sonarqubeConfigDir(baseDir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    projectConfigPath(baseDir),
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
}

// ── Workspace registry ──────────────────────────────────────────────────────

const WORKSPACE_REGISTRY_FILE = "sonarqube.workspaces.json";

export function workspaceRegistryPath(repoRoot: string): string {
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

export async function findRepoRoot(startDir: string): Promise<string> {
  let dir = resolve(startDir);
  for (;;) {
    if (await hasGitRootMarker(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

export async function loadWorkspaceRegistry(
  startDir: string,
): Promise<{ repoRoot: string; registry: SonarWorkspaceRegistry }> {
  const repoRoot = await findRepoRoot(startDir);
  const raw = await readOptionalJson<Partial<SonarWorkspaceRegistry>>(
    workspaceRegistryPath(repoRoot),
  );
  const workspaces =
    raw?.workspaces && typeof raw.workspaces === "object"
      ? { ...raw.workspaces }
      : {};
  return { repoRoot, registry: { version: 1, workspaces } };
}

export async function saveWorkspaceRegistry(
  startDir: string,
  alias: string,
  targetDir: string,
): Promise<void> {
  const { repoRoot, registry } = await loadWorkspaceRegistry(startDir);
  registry.workspaces[alias] = relative(repoRoot, targetDir) || ".";
  await mkdir(sonarqubeConfigDir(repoRoot), { recursive: true });
  await writeFile(
    workspaceRegistryPath(repoRoot),
    JSON.stringify(registry, null, 2) + "\n",
    "utf8",
  );
}

export function looksLikePath(token: string): boolean {
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

export function knownTargets(registry: SonarWorkspaceRegistry): string[] {
  return Object.keys(registry.workspaces).sort((left, right) =>
    left.localeCompare(right),
  );
}

export interface DiscoveredTarget {
  dir: string;
  alias?: string;
}

const SONARQUBE_CONFIG_FILE = ".pi/sonarqube.json";

// ── Target discovery ──────────────────────────────────────────────────────

async function execFd(repoRoot: string): Promise<string> {
  return execFileSync(
    "fd",
    [
      "--hidden",
      "-g",
      "sonarqube.json",
      "--base-directory",
      repoRoot,
      "--max-depth",
      "8",
      "--exclude",
      ".git",
      "--exclude",
      "node_modules",
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
}

export async function discoverSonarQubeTargets(
  repoRoot: string,
  strategy?: "auto" | "fd" | "walk",
): Promise<DiscoveredTarget[]> {
  if (strategy === "walk") {
    return walkForSonarqubeConfigs(repoRoot);
  }

  // Try fd first (auto default) or fd-only
  try {
    const output = await execFd(repoRoot);
    const parsed = parseDiscoveredPaths(output, repoRoot);
    if (parsed.length > 0 || strategy === "fd") return parsed;
  } catch (_e) {
    if (strategy === "fd") throw _e;
  }

  return walkForSonarqubeConfigs(repoRoot);
}

function parseDiscoveredPaths(
  output: string,
  repoRoot: string,
): DiscoveredTarget[] {
  const lines = output.trim().split("\n").filter(Boolean);
  const seen = new Set<string>();
  const targets: DiscoveredTarget[] = [];
  for (const line of lines) {
    const dir = resolve(repoRoot, dirname(dirname(line)));
    if (dir === repoRoot) continue;
    const key = relative(repoRoot, dir);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ dir, alias: undefined });
  }
  return targets;
}

async function walkForSonarqubeConfigs(
  repoRoot: string,
): Promise<DiscoveredTarget[]> {
  const configDirs: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        if (entry.name.startsWith(".") && entry.name !== ".pi") continue;
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        }
      }
      // Check if this dir has .pi/sonarqube.json
      try {
        await stat(resolve(dir, SONARQUBE_CONFIG_FILE));
        if (dir !== repoRoot) configDirs.push(dir);
      } catch {
        // no config here
      }
    } catch {
      // skip unreadable dirs
    }
  }

  await walk(repoRoot, 0);

  const seen = new Set<string>();
  const targets: DiscoveredTarget[] = [];
  for (const dir of configDirs) {
    const key = relative(repoRoot, dir);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ dir, alias: undefined });
  }
  return targets;
}

// ── Registered + discovered target merger ───────────────────────────────────

export interface MappedTarget {
  alias: string;
  path: string;
}

/**
 * Gather all available SonarQube targets from the workspace registry and from
 * disk discovery (`.pi/sonarqube.json`). Registry entries take precedence.
 */
export async function gatherTargets(
  startDir: string,
): Promise<{ repoRoot: string; targets: MappedTarget[] }> {
  const { repoRoot, registry } = await loadWorkspaceRegistry(startDir);
  const mapped = new Map<string, MappedTarget>();

  for (const [alias, relPath] of Object.entries(registry.workspaces)) {
    mapped.set(relPath, { alias, path: relPath });
  }

  const discovered = await discoverSonarQubeTargets(repoRoot);
  for (const d of discovered) {
    const relPath = relative(repoRoot, d.dir);
    if (!mapped.has(relPath)) {
      mapped.set(relPath, { alias: basename(d.dir), path: relPath });
    }
  }

  return {
    repoRoot,
    targets: [...mapped.values()],
  };
}

export async function resolveTarget(
  ctx: { cwd: string },
  targetInput?: string,
): Promise<ResolvedTarget> {
  const { repoRoot, registry } = await loadWorkspaceRegistry(ctx.cwd);
  if (!targetInput) {
    return { baseDir: ctx.cwd, repoRoot };
  }

  const aliasTarget = registry.workspaces[targetInput];
  if (aliasTarget) {
    const baseDir = resolve(repoRoot, aliasTarget);
    const baseDirStat = await stat(baseDir).catch(() => undefined);
    if (!baseDirStat?.isDirectory()) {
      throw new Error(
        `SonarQube target "${targetInput}" points to a missing directory: ${baseDir}`,
      );
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
  throw new Error(
    `Unknown SonarQube target "${targetInput}". Use /sonarqube init <alias> <path> to add one.`,
  );
}

export async function resolveInitTarget(
  ctx: { cwd: string },
  alias?: string,
  targetInput?: string,
): Promise<ResolvedTarget> {
  if (targetInput) {
    const resolved = await resolveTarget(ctx, targetInput);
    return { ...resolved, alias };
  }

  if (alias) {
    const { repoRoot, registry } = await loadWorkspaceRegistry(ctx.cwd);
    const aliasTarget = registry.workspaces[alias];
    if (aliasTarget) {
      return { baseDir: resolve(repoRoot, aliasTarget), repoRoot, alias };
    }
  }

  return { baseDir: ctx.cwd, repoRoot: await findRepoRoot(ctx.cwd) };
}

// ── Config resolution ───────────────────────────────────────────────────────

interface ResolveCtx {
  cwd: string;
  signal?: AbortSignal;
}

export async function resolveConfig(
  ctx: ResolveCtx,
  inputPath?: string,
): Promise<SonarProjectConfig> {
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
