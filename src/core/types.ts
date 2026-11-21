// ── Public types ──────────────────────────────────────────────────────────────

/** Result of running an external command; same shape as Pi's `pi.exec`. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

/** Runs an external command on behalf of the core (injected by the host). */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<CommandResult>;

/** Session-scoped storage of analysis results (injected by the host). */
export interface SessionStateStore {
  /** Last analysis state remembered for a project base directory. */
  get(baseDir: string): SonarAnalysisState | undefined;
  /** Remember a state in memory for this session. */
  remember(state: SonarAnalysisState): void;
  /** Persist a freshly produced analysis state in the host's session log. */
  persist(state: SonarAnalysisState): void;
}

/** Structurally compatible with the autocomplete items hosts render. */
export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface AutocompleteSuggestions {
  items: AutocompleteItem[];
  prefix: string;
}

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

export interface SonarDuplicationMeasures {
  duplicatedLinesDensity: number;
  duplicatedLines: number;
  duplicatedBlocks: number;
  duplicatedFiles: number;
  coverage?: number;
  linesToCover?: number;
  uncoveredLines?: number;
}

export interface IssueSeverityCounts {
  blocker: number;
  critical: number;
  major: number;
  minor: number;
  info: number;
}

export interface IssueQualityCounts {
  maintainability: number;
  reliability: number;
  security: number;
}

export interface FileDuplication {
  filePath: string;
  fileKey: string;
  duplicatedLines: number;
  duplicatedLinesDensity: number;
  duplicatedBlocks: number;
}

export interface DuplicationBlock {
  from: number;
  size: number;
  filePath: string;
}

export interface DuplicationBlockGroup {
  blocks: DuplicationBlock[];
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
  measures?: SonarDuplicationMeasures;
  totalIssues: number;
  issues: SonarIssue[];
  cleanCodeMode?: CleanCodeMode;
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
  softwareQualities?: string[];
  impactSeverities?: string[];
  issueKeys?: string[];
  pathScope?: string;
  componentKeys?: string[];
}

export interface SonarInitConfig {
  serverUrl: string;
  projectKey: string;
  token?: string;
}

// ── Internal types shared by adapter and extension ──────────────────────────

export type CleanCodeMode = "STANDARD" | "MQR";

export interface SonarWorkspaceRegistry {
  version: 1;
  workspaces: Record<string, string>;
}

export interface ResolvedTarget {
  baseDir: string;
  repoRoot: string;
  alias?: string;
}

export interface ParsedSonarIssueArgs {
  targetInput?: string;
  issueIndex?: number;
  issueKeys?: string[];
  filters?: SonarIssueFetchOptions;
}

export interface InitCommandOptions {
  alias?: string;
  targetInput?: string;
}

// ── Constants shared by adapter and extension ───────────────────────────────

export const SONAR_SEVERITIES = [
  "BLOCKER",
  "CRITICAL",
  "MAJOR",
  "MINOR",
  "INFO",
] as const;
export const SONAR_STATUSES = [
  "OPEN",
  "CONFIRMED",
  "REOPENED",
  "RESOLVED",
  "CLOSED",
] as const;
export const SONAR_TYPES = ["BUG", "VULNERABILITY", "CODE_SMELL"] as const;
export const SONAR_SOFTWARE_QUALITIES = [
  "MAINTAINABILITY",
  "RELIABILITY",
  "SECURITY",
] as const;
export const SONAR_IMPACT_SEVERITIES = [
  "BLOCKER",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFO",
] as const;
