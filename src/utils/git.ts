import { existsSync } from "node:fs";
import { $ } from "bun";
import type { GitCommit } from "./parse.ts";

export function isGitRepo(dir: string): boolean {
  return existsSync(dir + "/.git");
}

interface GitState {
  dirty: number;
  stashCount: number;
  branchCount: number;
  currentBranch: string;
}

/** In-process Bun Shell: status + stash + branches. No /bin/sh fork. */
export async function gitState(dir: string): Promise<GitState> {
  try {
    const out = await $`git status --porcelain; echo '---'; git stash list; echo '---'; git branch --no-color`
      .cwd(dir).quiet().nothrow().text();

    const [statusBlock = "", stashBlock = "", branchBlock = ""] = out.split("---\n");
    const statusLines = statusBlock.trim().split("\n").filter(Boolean);
    const stashLines = stashBlock.trim().split("\n").filter(Boolean);
    const branchLines = branchBlock.trim().split("\n").filter(Boolean);
    const currentLine = branchLines.find(l => l.startsWith("* "));

    return {
      dirty: statusLines.length,
      stashCount: stashLines.length,
      branchCount: branchLines.length,
      currentBranch: currentLine ? currentLine.slice(2).trim() : "unknown",
    };
  } catch {
    return { dirty: 0, stashCount: 0, branchCount: 0, currentBranch: "unknown" };
  }
}

/** Parse conventional commit: "type(scope): message" */
function parseConventional(message: string): { commitType?: string; commitScope?: string } {
  const m = message.match(/^(\w+)(?:\(([^)]*)\))?:\s/);
  if (!m) return {};
  return { commitType: m[1], commitScope: m[2] };
}

export async function gitRecentCommits(dir: string, since?: string): Promise<GitCommit[]> {
  try {
    const fmt = "%H|%aI|%an|%s";
    const out = since
      ? await $`git log --format=${fmt} --no-merges --since=${since}`.cwd(dir).quiet().nothrow().text()
      : await $`git log --format=${fmt} --no-merges`.cwd(dir).quiet().nothrow().text();
    if (!out.trim()) return [];

    return out.trim().split("\n").filter(Boolean).map(line => {
      const [hash = "", date = "", author = "", ...rest] = line.split("|");
      const message = rest.join("|");
      const { commitType, commitScope } = parseConventional(message);
      return { hash, date, message, author, commitType, commitScope };
    });
  } catch {
    return [];
  }
}
