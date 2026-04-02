import { resolve } from "node:path";
import { existsSync, renameSync } from "node:fs";
import { Glob } from "bun";
import { CLAUDE_HOME, PROJECTS_DIR, encodeProjectPath, DB_PATH } from "../utils/paths.ts";
import { bold, dim, cyan, yellow } from "../utils/format.ts";

const HOME = (Bun.env.HOME || (() => { throw new Error("HOME environment variable is not set"); })()).replace(/\/+$/, "");

function resolvePath(p: string): string {
  let result: string;
  if (p === "~") result = HOME;
  else if (p.startsWith("~/")) result = HOME + p.slice(1);
  else result = resolve(p);
  return result === "/" ? "/" : result.replace(/\/+$/, "");
}

function toTilde(abs: string): string {
  if (abs === HOME) return "~";
  if (abs.startsWith(HOME + "/")) return "~" + abs.slice(HOME.length);
  return abs;
}

function isBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 512);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const glob = new Glob("**/*");
  for await (const path of glob.scan({ cwd: dir, onlyFiles: true, dot: true })) {
    yield dir + "/" + path;
  }
}

interface ReplacePair {
  old: string;
  new: string;
}

function buildReplacements(oldAbs: string, newAbs: string): ReplacePair[] {
  const oldTilde = toTilde(oldAbs);
  const newTilde = toTilde(newAbs);
  const pairs: ReplacePair[] = [];
  if (oldAbs !== newAbs) pairs.push({ old: oldAbs, new: newAbs });
  if (oldTilde !== newTilde && oldTilde !== oldAbs) pairs.push({ old: oldTilde, new: newTilde });
  return pairs;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledPair {
  re: RegExp;
  replacement: string;
}

function compilePairs(pairs: ReplacePair[]): CompiledPair[] {
  return pairs.map(p => ({
    re: new RegExp(escapeRegex(p.old) + "(?![\\p{L}\\p{N}_.-])", "gu"),
    replacement: p.new,
  }));
}

function applyReplacements(content: string, compiled: CompiledPair[]): string {
  let result = content;
  for (const c of compiled) {
    const rep = c.replacement;
    result = result.replaceAll(c.re, () => rep);
  }
  return result;
}

async function updateDatabase(oldAbs: string, newAbs: string): Promise<number> {
  if (!existsSync(DB_PATH)) return 0;

  const { getDb } = await import("../db/connection.ts");
  const db = getDb();
  let rows = 0;

  const tables = [
    { table: "sessions", col: "project_path" },
    { table: "projects", col: "path" },
    { table: "project_git_state", col: "project_path" },
    { table: "commits", col: "project_path" },
    { table: "github_repos", col: "local_path" },
  ];

  const likePattern = oldAbs.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&") + "/%";

  for (const { table, col } of tables) {
    try {
      try {
        const r1 = db.run(
          `UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`,
          [newAbs, oldAbs],
        );
        rows += r1.changes;
      } catch {
        const r1 = db.run(`DELETE FROM ${table} WHERE ${col} = ?`, [oldAbs]);
        rows += r1.changes;
      }
      const r2 = db.run(
        `UPDATE ${table} SET ${col} = ? || substr(${col}, length(?) + 1) WHERE ${col} LIKE ? ESCAPE '\\' AND ${col} != ?`,
        [newAbs, oldAbs, likePattern, oldAbs],
      );
      rows += r2.changes;
    } catch (e) {
      const msg = (e as Error).message || "";
      if (!msg.includes("no such table")) {
        console.error(`Warning: failed to update ${table}.${col}: ${msg}`);
      }
    }
  }

  try {
    const newName = newAbs.split("/").pop() || newAbs;
    db.run(`UPDATE projects SET name = ? WHERE path = ?`, [newName, newAbs]);
  } catch (e) {
    const msg = (e as Error).message || "";
    if (!msg.includes("no such table")) {
      console.error(`Warning: failed to update project name: ${msg}`);
    }
  }

  return rows;
}

export async function mvCommand(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const filtered = args.filter(a => !a.startsWith("--"));

  if (filtered.length < 2) {
    console.error("Usage: ccbase mv <old-path> <new-path> [--dry-run]");
    console.error("\nRewrites all Claude Code internal references after moving a project directory.");
    console.error("Run this AFTER physically moving the directory.");
    process.exit(1);
  }

  if (!filtered[0] || !filtered[1]) {
    console.error("Paths cannot be empty.");
    process.exit(1);
  }

  const oldAbs = resolvePath(filtered[0]);
  const newAbs = resolvePath(filtered[1]);

  if (oldAbs === newAbs) {
    console.error("Old and new paths are identical.");
    process.exit(1);
  }

  if (oldAbs === "/" || CLAUDE_HOME === oldAbs || CLAUDE_HOME.startsWith(oldAbs + "/")) {
    console.error("Refusing to replace a parent of the Claude Code data directory.");
    console.error(`Old path ${oldAbs} is an ancestor of ${CLAUDE_HOME}`);
    process.exit(1);
  }
  if (newAbs.startsWith(oldAbs + "/")) {
    console.error("New path cannot be inside old path.");
    process.exit(1);
  }

  if (!existsSync(newAbs)) {
    console.error(`New path does not exist: ${newAbs}`);
    console.error("Move the directory first, then run this command.");
    process.exit(1);
  }
  if (existsSync(oldAbs)) {
    console.log(yellow("Warning:") + ` Old path still exists: ${oldAbs}`);
    console.log("Are you sure you moved it? Continuing anyway.\n");
  }

  if (!existsSync(CLAUDE_HOME)) {
    console.error(`Claude Code data directory not found: ${CLAUDE_HOME}`);
    process.exit(1);
  }

  const sessionsDir = CLAUDE_HOME + "/sessions";
  if (existsSync(sessionsDir)) {
    try {
      const sessionFiles = [...new Glob("*.json").scanSync(sessionsDir)];
      for (const f of sessionFiles) {
        const data = JSON.parse(await Bun.file(sessionsDir + "/" + f).text());
        if (data.pid && data.cwd) {
          try {
            process.kill(data.pid, 0);
            if (data.cwd === oldAbs || data.cwd === newAbs || data.cwd.startsWith(oldAbs + "/") || data.cwd.startsWith(newAbs + "/")) {
              console.log(yellow("Warning:") + ` Active Claude Code session (PID ${data.pid}) is using this project.`);
              console.log("Its JSONL file will have stale paths reintroduced as it writes new messages.");
              console.log("Run this command again after the session ends.\n");
            }
          } catch {}
        }
      }
    } catch {}
  }

  const pairs = buildReplacements(oldAbs, newAbs);
  const compiled = compilePairs(pairs);
  if (dryRun) {
    console.log(bold("Dry run") + ", no files will be modified.\n");
  }

  console.log(`${bold("Old:")} ${oldAbs}`);
  console.log(`${bold("New:")} ${newAbs}`);
  console.log(`${bold("Replacements:")}`);
  for (const p of pairs) console.log(`  ${dim(p.old)} → ${p.new}`);
  console.log();

  let scanned = 0;
  let modified = 0;
  let occurrences = 0;
  let skippedBinary = 0;

  for await (const filePath of walkFiles(CLAUDE_HOME)) {
    scanned++;
    try {
      const file = Bun.file(filePath);
      const bytes = await file.bytes();

      if (isBinary(bytes)) { skippedBinary++; continue; }

      const content = new TextDecoder().decode(bytes);

      const hasOld = pairs.some(p => content.includes(p.old));
      if (!hasOld) continue;

      let count = 0;
      for (const c of compiled) {
        const matches = content.match(c.re);
        if (matches) count += matches.length;
      }

      const replaced = applyReplacements(content, compiled);
      if (replaced === content) continue;
      occurrences += count;

      if (dryRun) {
        const rel = filePath.replace(CLAUDE_HOME + "/", "");
        console.log(`  ${cyan(rel)} (${count} refs)`);
      } else {
        try {
          await Bun.write(filePath, replaced);
        } catch (e) {
          console.error(`Failed to write ${filePath.replace(CLAUDE_HOME + "/", "")}: ${(e as Error).message}`);
          continue;
        }
      }
      modified++;
    } catch {}
  }

  const rootConfig = HOME + "/.claude.json";
  if (existsSync(rootConfig)) {
    try {
      const text = await Bun.file(rootConfig).text();
      if (pairs.some(p => text.includes(p.old))) {
        const replaced = applyReplacements(text, compiled);
        if (replaced !== text) {
          let count = 0;
          for (const c of compiled) {
            const matches = text.match(c.re);
            if (matches) count += matches.length;
          }
          occurrences += count;
          if (dryRun) {
            console.log(`  ${cyan(".claude.json")} (${count} refs)`);
          } else {
            try {
              await Bun.write(rootConfig, replaced);
            } catch (e) {
              console.error(`Failed to write .claude.json: ${(e as Error).message}`);
            }
          }
          modified++;
        }
      }
    } catch {}
    scanned++;
  }

  console.log(`\n${bold("Files:")} ${scanned} scanned, ${modified} ${dryRun ? "would be " : ""}modified, ${skippedBinary} binary skipped`);
  console.log(`${bold("Refs:")} ${occurrences} path occurrences ${dryRun ? "found" : "replaced"}`);

  const oldEncoded = encodeProjectPath(oldAbs);
  const newEncoded = encodeProjectPath(newAbs);
  const oldDir = PROJECTS_DIR + "/" + oldEncoded;
  const newDir = PROJECTS_DIR + "/" + newEncoded;

  if (existsSync(oldDir) && oldEncoded !== newEncoded) {
    if (dryRun) {
      console.log(`\n${bold("Project dir:")} would rename`);
      console.log(`  ${dim(oldEncoded)} → ${newEncoded}`);
    } else {
      if (existsSync(newDir)) {
        console.log(yellow("\nWarning:") + ` Target project dir already exists: ${newEncoded}`);
        console.log("Skipping directory rename. You may need to merge manually.");
      } else {
        try {
          renameSync(oldDir, newDir);
          console.log(`\n${bold("Project dir:")} renamed`);
          console.log(`  ${dim(oldEncoded)} → ${newEncoded}`);
        } catch (e) {
          console.error(`\n${yellow("Error:")} Failed to rename project dir: ${(e as Error).message}`);
          console.error("You may need to rename it manually:");
          console.error(`  mv "${oldDir}" "${newDir}"`);
        }
      }
    }
  } else if (!existsSync(oldDir)) {
    console.log(`\n${dim("Project dir already renamed or not found.")}`);
  }

  if (!dryRun) {
    const dbRows = await updateDatabase(oldAbs, newAbs);
    if (dbRows > 0) console.log(`${bold("Database:")} ${dbRows} rows updated`);
  }

  if (dryRun) {
    console.log(`\nRun without ${bold("--dry-run")} to apply changes.`);
  } else {
    console.log(`\n${bold("Done.")} Run ${cyan("ccbase ingest --force")} to fully refresh.`);
  }
}
