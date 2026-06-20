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

// ── Internal types shared by adapter and extension ──────────────────────────

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
  filters?: SonarIssueFetchOptions;
}

export interface InitCommandOptions {
  alias?: string;
  targetInput?: string;
}

// ── Constants shared by adapter and extension ───────────────────────────────

export const SONAR_SEVERITIES = ["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"] as const;
export const SONAR_STATUSES = ["OPEN", "CONFIRMED", "REOPENED", "RESOLVED", "CLOSED"] as const;
export const SONAR_TYPES = ["BUG", "VULNERABILITY", "CODE_SMELL"] as const;
