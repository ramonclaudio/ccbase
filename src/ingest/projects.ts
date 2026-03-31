import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import type { Database } from "bun:sqlite";
import { DEVELOPER_DIR, listDirs } from "../utils/paths.ts";
import { isGitRepo, gitState, gitRecentCommits } from "../utils/git.ts";

const SKIP_DIRS = new Set(["prompts"]);
const TYPED_PARENTS = new Map([
  ["private", "private"],
  ["public", "public"],
  ["forks", "fork"],
  ["refs", "ref"],
]);

function getGitAuthorNames(): Set<string> {
  try {
    const name = execSync("git config --get user.name", { encoding: "utf-8" }).trim();
    const email = execSync("git config --get user.email", { encoding: "utf-8" }).trim();
    const username = email.split("@")[0] || "";
    const names = new Set<string>();
    if (name) names.add(name);
    if (username) names.add(username);
    // Add common variations
    if (name.includes(" ")) {
      names.add(name.split(" ")[0]!); // first name only
    }
    return names;
  } catch {
    return new Set();
  }
}

const MY_NAMES = getGitAuthorNames();

interface ProjectData {
  path: string;
  name: string;
  type: string;
  hasGit: boolean;
  hasClaudeMd: boolean;
  lastCommitDate: string | null;
  totalCommits: number;
  gitState: {
    branchCount: number;
    stashCount: number;
    dirtyCount: number;
    currentBranch: string;
  } | null;
  commits: {
    hash: string;
    author: string;
    date: string;
    message: string;
    commitType: string | null;
    commitScope: string | null;
  }[];
}

function listProjects(): { path: string; type: string }[] {
  const projects: { path: string; type: string }[] = [];
  if (!existsSync(DEVELOPER_DIR)) return projects;

  const topLevel = listDirs(DEVELOPER_DIR);
  for (const name of topLevel) {
    if (name.startsWith(".")) continue;
    if (SKIP_DIRS.has(name)) continue;

    const parentPath = DEVELOPER_DIR + "/" + name;
    const projectType = TYPED_PARENTS.get(name);

    if (projectType) {
      try {
        const children = listDirs(parentPath);
        for (const child of children) {
          if (child.startsWith(".")) continue;
          projects.push({ path: parentPath + "/" + child, type: projectType });
        }
      } catch (e) {
        console.error(`Failed to scan ${parentPath}:`, e);
      }
    } else {
      projects.push({ path: parentPath, type: "other" });
    }
  }

  return projects;
}

async function collectProjectData(proj: { path: string; type: string }): Promise<ProjectData> {
  const { path, type } = proj;
  const name = path.split("/").pop() || path;
  const hasGit = isGitRepo(path);
  const hasClaudeMd = existsSync(path + "/CLAUDE.md");

  let lastCommitDate: string | null = null;
  let totalCommits = 0;
  let gs: ProjectData["gitState"] = null;
  let commits: ProjectData["commits"] = [];

  if (hasGit) {
    const [state, allCommits] = await Promise.all([gitState(path), gitRecentCommits(path)]);
    gs = {
      branchCount: state.branchCount,
      stashCount: state.stashCount,
      dirtyCount: state.dirty,
      currentBranch: state.currentBranch,
    };

    const myCommits = allCommits.filter(c => MY_NAMES.has(c.author));
    totalCommits = myCommits.length;
    if (myCommits.length > 0) {
      lastCommitDate = myCommits[0]!.date.slice(0, 10);
    }

    commits = myCommits.map(c => ({
      hash: c.hash,
      author: c.author,
      date: c.date,
      message: c.message,
      commitType: c.commitType ?? null,
      commitScope: c.commitScope ?? null,
    }));
  }

  return { path, name, type, hasGit, hasClaudeMd, lastCommitDate, totalCommits, gitState: gs, commits };
}

function insertProjectData(
  d: ProjectData,
  stmts: { project: ReturnType<Database["query"]>; gitState: ReturnType<Database["query"]>; commit: ReturnType<Database["query"]> },
): void {
  if (d.gitState) {
    stmts.gitState.run(
      d.path, d.gitState.branchCount, d.gitState.stashCount,
      d.gitState.dirtyCount, d.gitState.dirtyCount > 0 ? 1 : 0,
      d.gitState.currentBranch, new Date().toISOString(),
    );
  }

  for (const c of d.commits) {
    stmts.commit.run(c.hash, d.path, c.author, c.date, c.message, c.commitType, c.commitScope);
  }

  stmts.project.run(
    d.path, d.name, d.type, d.hasGit ? 1 : 0, d.hasClaudeMd ? 1 : 0,
    d.lastCommitDate, d.totalCommits,
  );
}

export async function ingestProjects(db: Database): Promise<number> {
  const projects = listProjects();
  if (projects.length === 0) return 0;

  const results = await Promise.allSettled(projects.map(p => collectProjectData(p)));
  const projectData = results
    .filter((r): r is PromiseFulfilledResult<ProjectData> => r.status === "fulfilled")
    .map(r => r.value);

  const stmts = {
    project: db.query(`
      INSERT OR REPLACE INTO projects (path, name, type, has_git, has_claude_md, last_commit_date, total_commits)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    gitState: db.query(`
      INSERT OR REPLACE INTO project_git_state
      (project_path, branch_count, stash_count, dirty_file_count, uncommitted_changes, current_branch, last_captured)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    commit: db.query(`
      INSERT OR REPLACE INTO commits (hash, project_path, author, date, message, commit_type, commit_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
  };

  db.transaction(() => {
    for (const d of projectData) insertProjectData(d, stmts);
  })();

  return projectData.length;
}
