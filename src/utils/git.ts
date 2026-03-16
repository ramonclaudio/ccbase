import { join } from "node:path";
import { existsSync } from "node:fs";
import type { GitCommit } from "./parse.ts";

function run(
  args: string[],
  cwd: string,
): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

export function gitStatus(dir: string): { dirty: number; files: string[] } {
  const { ok, stdout } = run(["status", "--porcelain"], dir);
  if (!ok || !stdout) return { dirty: 0, files: [] };
  const files = stdout.split("\n").filter(Boolean);
  return { dirty: files.length, files };
}

export function gitBranches(dir: string): { current: string; count: number } {
  const { ok, stdout } = run(["branch", "--no-color"], dir);
  if (!ok || !stdout) return { current: "unknown", count: 0 };
  const lines = stdout.split("\n").filter(Boolean);
  const currentLine = lines.find((l) => l.startsWith("* "));
  const current = currentLine ? currentLine.slice(2).trim() : "unknown";
  return { current, count: lines.length };
}

export function gitStashCount(dir: string): number {
  const { ok, stdout } = run(["stash", "list"], dir);
  if (!ok || !stdout) return 0;
  return stdout.split("\n").filter(Boolean).length;
}

export function gitCurrentBranch(dir: string): string {
  const { ok, stdout } = run(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  return ok && stdout ? stdout : "unknown";
}

/** Parse conventional commit: "type(scope): message" */
function parseConventional(message: string): {
  commitType?: string;
  commitScope?: string;
} {
  const m = message.match(/^(\w+)(?:\(([^)]*)\))?:\s/);
  if (!m) return {};
  return { commitType: m[1], commitScope: m[2] };
}

export function gitRecentCommits(dir: string, since?: string): GitCommit[] {
  const args = [
    "log",
    "--format=%H|%aI|%an|%s",
    "--no-merges",
  ];
  if (since) args.push(`--since=${since}`);

  const { ok, stdout } = run(args, dir);
  if (!ok || !stdout) return [];

  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", date = "", author = "", ...rest] = line.split("|");
      const message = rest.join("|");
      const { commitType, commitScope } = parseConventional(message);
      return { hash, date, message, author, commitType, commitScope };
    });
}
