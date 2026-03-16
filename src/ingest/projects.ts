import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { DEVELOPER_DIR } from "../utils/paths.ts";
import {
  isGitRepo,
  gitStatus,
  gitStashCount,
  gitBranches,
  gitCurrentBranch,
  gitRecentCommits,
} from "../utils/git.ts";

const SKIP_DIRS = new Set(["prompts"]);
const TYPED_PARENTS = new Map([
  ["private", "private"],
  ["public", "public"],
  ["forks", "fork"],
  ["refs", "ref"],
]);

function listProjects(): { path: string; type: string }[] {
  const projects: { path: string; type: string }[] = [];
  if (!existsSync(DEVELOPER_DIR)) return projects;

  const topLevel = readdirSync(DEVELOPER_DIR, { withFileTypes: true });
  for (const entry of topLevel) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const parentPath = join(DEVELOPER_DIR, entry.name);
    const projectType = TYPED_PARENTS.get(entry.name);

    if (projectType) {
      // Scan children as individual projects
      try {
        const children = readdirSync(parentPath, { withFileTypes: true });
        for (const child of children) {
          if (!child.isDirectory() || child.name.startsWith(".")) continue;
          projects.push({ path: join(parentPath, child.name), type: projectType });
        }
      } catch (e) {
        console.error(`Failed to scan ${parentPath}:`, e);
      }
    } else {
      // Top-level dir is itself a project
      projects.push({ path: parentPath, type: "other" });
    }
  }

  return projects;
}

const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 86_400_000)
  .toISOString()
  .slice(0, 10);

export async function ingestProjects(db: Database): Promise<number> {
  const projects = listProjects();
  if (projects.length === 0) return 0;

  const insertProject = db.prepare(`
    INSERT OR REPLACE INTO projects (path, name, type, has_git, has_claude_md, last_commit_date, total_commits)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertGitState = db.prepare(`
    INSERT OR REPLACE INTO project_git_state
    (project_path, branch_count, stash_count, dirty_file_count, uncommitted_changes, current_branch, last_captured)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertCommit = db.prepare(`
    INSERT OR REPLACE INTO commits (hash, project_path, author, date, message, commit_type, commit_scope)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;

  const tx = db.transaction(() => {
    for (const { path, type } of projects) {
      try {
        const name = basename(path);
        const hasGit = isGitRepo(path);
        const hasClaudeMd = existsSync(join(path, "CLAUDE.md"));

        let lastCommitDate: string | null = null;
        let totalCommits = 0;

        if (hasGit) {
          // Git state
          const status = gitStatus(path);
          const stashes = gitStashCount(path);
          const branches = gitBranches(path);
          const branch = gitCurrentBranch(path);

          insertGitState.run(
            path,
            branches.count,
            stashes,
            status.dirty,
            status.dirty > 0 ? 1 : 0,
            branch,
            new Date().toISOString(),
          );

          // Commits - only mine across all repos (including forks/refs)
          const MY_NAMES = ["Ray", "the author", "the author", "ramonclaudio"];
          const allCommits = gitRecentCommits(path);
          const myCommits = allCommits.filter(c => MY_NAMES.includes(c.author));
          totalCommits = myCommits.length;
          if (myCommits.length > 0) {
            lastCommitDate = myCommits[0]!.date.slice(0, 10);
          }

          for (const c of myCommits) {
            insertCommit.run(
              c.hash,
              path,
              c.author,
              c.date,
              c.message,
              c.commitType ?? null,
              c.commitScope ?? null,
            );
          }
        }

        insertProject.run(
          path,
          name,
          type,
          hasGit ? 1 : 0,
          hasClaudeMd ? 1 : 0,
          lastCommitDate,
          totalCommits,
        );

        count++;
      } catch (e) {
        console.error(`Failed to ingest project ${path}:`, e);
      }
    }
  });

  tx();
  return count;
}
