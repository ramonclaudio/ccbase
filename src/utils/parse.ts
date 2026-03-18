// ── Interfaces ──────────────────────────────────────────────────────

export interface HistoryEntry {
  display: string;
  pastedContents: Record<string, unknown>;
  timestamp: number;
  project: string;
  sessionId: string;
}

interface SessionsIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: number;
  modified: number;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

export interface SessionsIndexFile {
  version: number;
  entries: SessionsIndexEntry[];
}

interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  /** Only present in top-level stats-cache modelUsage */
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface StatsCache {
  version: number;
  lastComputedDate: string;
  dailyActivity: DailyActivity[];
  dailyModelTokens: unknown[];
  modelUsage: Record<string, ModelUsage>;
}

interface RootConfigProject {
  allowedTools: string[];
  lastCost: number;
  lastAPIDuration: number;
  lastAPIDurationWithoutRetries: number;
  lastToolDuration: number;
  lastDuration: number;
  lastLinesAdded: number;
  lastLinesRemoved: number;
  lastTotalInputTokens: number;
  lastTotalOutputTokens: number;
  lastTotalCacheCreationInputTokens: number;
  lastTotalCacheReadInputTokens: number;
  lastTotalWebSearchRequests: number;
  lastModelUsage: Record<string, ModelUsage>;
  lastSessionId: string;
  lastSessionMetrics?: Record<string, unknown>;
  lastFpsAverage?: number;
  lastFpsLow1Pct?: number;
  [key: string]: unknown;
}

export interface RootConfig {
  numStartups: number;
  userID: string;
  firstStartTime: number;
  projects: Record<string, RootConfigProject>;
  [key: string]: unknown;
}

export interface GitCommit {
  hash: string;
  date: string;
  message: string;
  author: string;
  commitType?: string;
  commitScope?: string;
}

// ── Parsers ─────────────────────────────────────────────────────────

export function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function parseJsonFile<T>(path: string): Promise<T> {
  return Bun.file(path).json() as Promise<T>;
}

