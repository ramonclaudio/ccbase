import { resolve } from "node:path";
import { existsSync, renameSync, mkdirSync, cpSync, rmSync, readdirSync, rmdirSync, realpathSync } from "node:fs";
import { Glob } from "bun";
import { CLAUDE_HOME, CLAUDE_CONFIG, CLAUDE_CONFIG_BACKUP, MCP_CACHE_DIR, PROJECTS_DIR, BACKUP_DIR, encodeProjectPath, DB_PATH } from "../utils/paths.ts";
import { bold, dim, cyan, yellow } from "../utils/format.ts";

const HOME = (Bun.env.HOME || (() => { throw new Error("HOME environment variable is not set"); })()).replace(/\/+$/, "");

function realpathSafe(p: string): string {
  try { return realpathSync(p); } catch {}
  const lastSep = p.lastIndexOf("/");
  if (lastSep <= 0) return p;
  const parent = p.slice(0, lastSep);
  const base = p.slice(lastSep + 1);
  try { return realpathSync(parent) + "/" + base; } catch {}
  return p;
}

function resolveUser(p: string): string {
  let result: string;
  if (p === "~") result = HOME;
  else if (p.startsWith("~/")) result = HOME + p.slice(1);
  else result = resolve(p);
  return result === "/" ? "/" : result.replace(/\/+$/, "");
}

function resolvePath(p: string): string {
  return realpathSafe(resolveUser(p));
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

function buildReplacements(oldUser: string, newUser: string, oldReal?: string, newReal?: string): ReplacePair[] {
  const pairs: ReplacePair[] = [];
  const seen = new Set<string>();
  const add = (o: string, n: string) => {
    if (o === n) return;
    const k = o + "\0" + n;
    if (seen.has(k)) return;
    seen.add(k);
    pairs.push({ old: o, new: n });
  };
  const oR = oldReal ?? oldUser;
  const nR = newReal ?? newUser;
  add(oR, nR);
  add(oldUser, newUser);
  add(toTilde(oR), toTilde(nR));
  add(toTilde(oldUser), toTilde(newUser));
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

interface FileResult {
  scanned: boolean;
  binary: boolean;
  modified: boolean;
  count: number;
}

function sha256Hex(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

async function processFile(
  filePath: string,
  pairs: ReplacePair[],
  compiled: CompiledPair[],
  label: string,
  dryRun: boolean,
  expectedShas?: Map<string, string>,
): Promise<FileResult> {
  try {
    const bytes = await Bun.file(filePath).bytes();
    if (isBinary(bytes)) return { scanned: true, binary: true, modified: false, count: 0 };

    const content = new TextDecoder().decode(bytes);
    if (!pairs.some(p => content.includes(p.old))) return { scanned: true, binary: false, modified: false, count: 0 };

    let count = 0;
    for (const c of compiled) {
      const matches = content.match(c.re);
      if (matches) count += matches.length;
    }

    const replaced = applyReplacements(content, compiled);
    if (replaced === content) return { scanned: true, binary: false, modified: false, count: 0 };

    if (dryRun) {
      console.log(`  ${cyan(label)} (${count} refs)`);
    } else {
      try {
        await Bun.write(filePath, replaced);
        if (expectedShas) expectedShas.set(filePath, sha256Hex(replaced));
      } catch (e) {
        console.error(`Failed to write ${label}: ${(e as Error).message}`);
        return { scanned: true, binary: false, modified: false, count: 0 };
      }
    }
    return { scanned: true, binary: false, modified: true, count };
  } catch {
    return { scanned: true, binary: false, modified: false, count: 0 };
  }
}

interface VerifyResult {
  shaChecked: number;
  shaMismatches: string[];
  staleOldRefs: { file: string; count: number }[];
  invalidJsonl: { file: string; line: number }[];
}

async function verifyApply(
  expectedShas: Map<string, string>,
  pairs: ReplacePair[],
  dstProjectDir: string,
): Promise<VerifyResult> {
  const result: VerifyResult = { shaChecked: 0, shaMismatches: [], staleOldRefs: [], invalidJsonl: [] };

  for (const [filePath, expectedSha] of expectedShas) {
    if (!existsSync(filePath)) {
      result.shaMismatches.push(filePath + " (missing)");
      continue;
    }
    try {
      const actual = sha256Hex(await Bun.file(filePath).text());
      result.shaChecked++;
      if (actual !== expectedSha) result.shaMismatches.push(filePath);
    } catch (e) {
      result.shaMismatches.push(filePath + " (read failed: " + (e as Error).message + ")");
    }
  }

  for await (const filePath of walkFiles(CLAUDE_HOME)) {
    try {
      const bytes = await Bun.file(filePath).bytes();
      if (isBinary(bytes)) continue;
      const content = new TextDecoder().decode(bytes);
      let count = 0;
      for (const p of pairs) {
        let idx = 0;
        while ((idx = content.indexOf(p.old, idx)) !== -1) {
          const next = content.charCodeAt(idx + p.old.length);
          if (!isNaN(next) && /[\p{L}\p{N}_.-]/u.test(String.fromCharCode(next))) {
            idx += p.old.length;
            continue;
          }
          count++;
          idx += p.old.length;
        }
      }
      if (count > 0) result.staleOldRefs.push({ file: filePath, count });
    } catch {}
  }

  if (existsSync(dstProjectDir)) {
    for await (const filePath of walkFiles(dstProjectDir)) {
      if (!filePath.endsWith(".jsonl")) continue;
      try {
        const text = await Bun.file(filePath).text();
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.length === 0) continue;
          try { JSON.parse(lines[i]!); } catch {
            result.invalidJsonl.push({ file: filePath, line: i + 1 });
            break;
          }
        }
      } catch {}
    }
  }

  return result;
}

function safeRename(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true, force: true });
  }
}

interface MergeStats {
  moved: number;
  conflicts: string[];
}

function mergeDir(srcDir: string, dstDir: string, prefix = ""): MergeStats {
  const stats: MergeStats = { moved: 0, conflicts: [] };
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = srcDir + "/" + entry.name;
    const dst = dstDir + "/" + entry.name;
    const label = prefix + entry.name;
    if (!existsSync(dst)) {
      safeRename(src, dst);
      stats.moved++;
      continue;
    }
    if (entry.isDirectory()) {
      const sub = mergeDir(src, dst, label + "/");
      stats.moved += sub.moved;
      stats.conflicts.push(...sub.conflicts);
    } else {
      stats.conflicts.push(label);
    }
  }
  try { rmdirSync(srcDir); } catch {}
  return stats;
}

function deepMerge(dst: unknown, src: unknown): unknown {
  if (Array.isArray(dst) && Array.isArray(src)) {
    const set = new Set(dst.map(v => JSON.stringify(v)));
    for (const v of src) {
      const s = JSON.stringify(v);
      if (!set.has(s)) { dst.push(v); set.add(s); }
    }
    return dst;
  }
  if (dst && typeof dst === "object" && src && typeof src === "object") {
    const d = dst as Record<string, unknown>;
    const s = src as Record<string, unknown>;
    for (const k of Object.keys(s)) {
      d[k] = k in d ? deepMerge(d[k], s[k]) : s[k];
    }
    return d;
  }
  return dst;
}

async function mergeClaudeJsonProjectsKey(cfgPath: string, oldPath: string, newPath: string): Promise<boolean> {
  if (oldPath === newPath) return false;
  if (!existsSync(cfgPath)) return false;
  let text: string;
  try { text = await Bun.file(cfgPath).text(); } catch { return false; }
  let json: { projects?: Record<string, unknown> };
  try { json = JSON.parse(text); } catch { return false; }
  if (!json.projects || typeof json.projects !== "object") return false;
  const oldEntry = json.projects[oldPath];
  if (oldEntry === undefined) return false;
  const newEntry = json.projects[newPath];
  json.projects[newPath] = newEntry === undefined ? oldEntry : deepMerge(newEntry, oldEntry);
  delete json.projects[oldPath];
  await Bun.write(cfgPath, JSON.stringify(json, null, 2) + "\n");
  return true;
}

function archiveSourceDir(srcPath: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const parts = srcPath.split("/").filter(p => p.length > 0);
  const base = parts[parts.length - 1] || "root";
  const parent = parts.length > 1 ? parts[parts.length - 2] : "root";
  mkdirSync(BACKUP_DIR, { recursive: true });
  let dst = `${BACKUP_DIR}/${base}-${parent}-${ts}`;
  let n = 2;
  while (existsSync(dst)) dst = `${BACKUP_DIR}/${base}-${parent}-${ts}-${n++}`;
  safeRename(srcPath, dst);
  return dst;
}

async function snapshotBackup(items: string[]): Promise<string | null> {
  const present = [...new Set(items)].filter(p => existsSync(p));
  if (present.length === 0) return null;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = CLAUDE_HOME + "/backups";
  const backupFile = backupDir + `/ccbase-mv-${ts}.tar.gz`;

  mkdirSync(backupDir, { recursive: true });
  const proc = Bun.spawn(["tar", "-czf", backupFile, ...present], { stderr: "pipe", stdout: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar exited ${code}: ${err}`);
  }
  return backupFile;
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

interface MoveOp {
  src: string;
  srcUser: string;
  srcEncoded: string;
  srcDir: string;
  srcCacheDir: string;
  isMerge: boolean;
  encodedNoop: boolean;
}

function printUsage(): void {
  console.error("Usage: ccbase mv <src1> [<src2> ...] <dst> [--apply] [--merge] [--no-project] [--no-backup]");
  console.error("\nRewrites Claude Code's internal references after moving (or merging) project directories.");
  console.error("Run AFTER physically moving the source directories.");
  console.error("\nFlags:");
  console.error("  --apply       Commit the changes (default is dry-run)");
  console.error("  --merge       Combine source sessions into an existing destination project");
  console.error("  --no-project  Skip rewriting files inside the destination project's own .claude/");
  console.error("  --no-backup   Skip the pre-apply snapshot tarball (not recommended)");
  console.error("  --no-verify   Skip the post-apply SHA + stale-ref + JSONL parse checks");
  console.error("  --no-archive  Skip moving source physical dirs to CCBASE_BACKUP_DIR");
  console.error("\nExamples:");
  console.error("  ccbase mv ~/code/old-name ~/code/new-name --apply");
  console.error("  ccbase mv ~/code/app-monorepo ~/code/app --merge --apply");
  console.error("  ccbase mv ~/code/a ~/code/b ~/code/c ~/code/final --merge --apply");
}

export async function mvCommand(args: string[]): Promise<void> {
  const apply = args.includes("--apply");
  const noProject = args.includes("--no-project");
  const noBackup = args.includes("--no-backup");
  const noVerify = args.includes("--no-verify");
  const noArchive = args.includes("--no-archive");
  const merge = args.includes("--merge");
  const positionals = args.filter(a => !a.startsWith("--"));

  if (positionals.length < 2) {
    printUsage();
    process.exit(1);
  }

  const expectedShas = apply && !noVerify ? new Map<string, string>() : undefined;
  if (positionals.some(p => !p)) {
    console.error("Paths cannot be empty.");
    process.exit(1);
  }

  const dstUser = resolveUser(positionals[positionals.length - 1]!);
  const dstAbs = realpathSafe(dstUser);
  const sourceList = positionals.slice(0, -1).map(p => ({ user: resolveUser(p), real: resolvePath(p) }));
  const seenReal = new Set<string>();
  const dedupedSources = sourceList.filter(s => {
    if (seenReal.has(s.real)) return false;
    seenReal.add(s.real);
    return true;
  });

  if (dedupedSources.some(s => s.real === dstAbs)) {
    console.error("A source path is identical to the destination.");
    process.exit(1);
  }
  if (!existsSync(dstAbs)) {
    console.error(`Destination does not exist on disk: ${dstAbs}`);
    console.error("Move the directory first (e.g. `mv src dst`), then run this command.");
    process.exit(1);
  }
  if (!existsSync(CLAUDE_HOME)) {
    console.error(`Claude Code data directory not found: ${CLAUDE_HOME}`);
    process.exit(1);
  }

  for (const s of dedupedSources) {
    const src = s.real;
    if (src === "/" || CLAUDE_HOME === src || CLAUDE_HOME.startsWith(src + "/")) {
      console.error(`Refusing: source ${src} is an ancestor of ${CLAUDE_HOME}`);
      process.exit(1);
    }
    if (MCP_CACHE_DIR === src || MCP_CACHE_DIR.startsWith(src + "/")) {
      console.error(`Refusing: source ${src} is an ancestor of ${MCP_CACHE_DIR}`);
      process.exit(1);
    }
    if (dstAbs.startsWith(src + "/")) {
      console.error(`Refusing: destination ${dstAbs} is inside source ${src}`);
      process.exit(1);
    }
  }

  const dstEncoded = encodeProjectPath(dstAbs);
  const dstDir = PROJECTS_DIR + "/" + dstEncoded;
  const dstCacheDir = MCP_CACHE_DIR + "/" + dstEncoded;

  const ops: MoveOp[] = dedupedSources.map(s => {
    const srcEncoded = encodeProjectPath(s.real);
    const srcDir = PROJECTS_DIR + "/" + srcEncoded;
    const srcCacheDir = MCP_CACHE_DIR + "/" + srcEncoded;
    const encodedNoop = srcEncoded === dstEncoded;
    const isMerge = !encodedNoop && existsSync(srcDir) && existsSync(dstDir);
    return { src: s.real, srcUser: s.user, srcEncoded, srcDir, srcCacheDir, isMerge, encodedNoop };
  });

  const mergeOps = ops.filter(o => o.isMerge);
  if (mergeOps.length > 0 && !merge) {
    console.error(`${yellow("Error:")} Destination project dir already exists for ${mergeOps.length} source(s).`);
    for (const op of mergeOps) console.error(`  ${op.srcEncoded} → ${dstEncoded}`);
    console.error("Pass --merge to combine source sessions into the existing destination.");
    process.exit(1);
  }

  for (const op of ops) {
    if (existsSync(op.src)) {
      console.log(yellow("Warning:") + ` Source still exists on disk: ${op.src}`);
      console.log("Are you sure you moved it? Continuing anyway.\n");
    }
  }

  const sessionsDir = CLAUDE_HOME + "/sessions";
  if (existsSync(sessionsDir)) {
    try {
      const sessionFiles = [...new Glob("*.json").scanSync(sessionsDir)];
      const watched = new Set([...dedupedSources, dstAbs]);
      for (const f of sessionFiles) {
        let data: { pid?: number; cwd?: string };
        try { data = JSON.parse(await Bun.file(sessionsDir + "/" + f).text()); } catch { continue; }
        if (!data.pid || !data.cwd) continue;
        try {
          process.kill(data.pid, 0);
          const cwd = data.cwd;
          for (const w of watched) {
            if (cwd === w || cwd.startsWith(w + "/")) {
              console.log(yellow("Warning:") + ` Active Claude Code session (PID ${data.pid}) using ${w}`);
              console.log("Its JSONL file may have stale paths reintroduced as it writes.");
              console.log("Re-run after the session ends.\n");
              break;
            }
          }
        } catch {}
      }
    } catch {}
  }

  const allPairs: ReplacePair[] = [];
  for (const op of ops) allPairs.push(...buildReplacements(op.srcUser, dstUser, op.src, dstAbs));
  const compiled = compilePairs(allPairs);

  if (!apply) console.log(bold("DRY RUN") + " (pass --apply to commit)\n");
  console.log(`${bold("Destination:")} ${dstAbs}`);
  console.log(`${bold("Sources (")}${ops.length}${bold("):")}`);
  for (const op of ops) {
    const tag = op.encodedNoop ? "(content-only)" : op.isMerge ? "(merge)" : "(rename)";
    console.log(`  ${dim(op.src)} ${tag}`);
  }
  console.log(`${bold("Replacements:")}`);
  for (const p of allPairs) console.log(`  ${dim(p.old)} → ${p.new}`);
  console.log();

  if (apply && !noBackup) {
    const items: string[] = [];
    for (const op of ops) { items.push(op.srcDir); items.push(op.srcCacheDir); }
    items.push(dstDir, dstCacheDir, CLAUDE_CONFIG, CLAUDE_CONFIG_BACKUP, CLAUDE_HOME + "/history.jsonl");
    try {
      const backupFile = await snapshotBackup(items);
      if (backupFile) {
        console.log(`${bold("Backup:")} ${dim(backupFile)}`);
        console.log(`${dim("Restore with: cd / && tar xzf " + backupFile)}\n`);
      }
    } catch (e) {
      console.error(yellow("Warning:") + ` Snapshot backup failed: ${(e as Error).message}`);
      console.error("Pass --no-backup to silence, or fix the underlying error.\n");
      process.exit(1);
    }
  }

  for (const op of ops) {
    if (op.encodedNoop || !existsSync(op.srcDir)) continue;
    const collision = existsSync(dstDir);
    if (!apply) {
      console.log(`${bold("Project dir:")} would ${collision ? "merge" : "rename"} ${dim(op.srcEncoded)} → ${dstEncoded}`);
    } else if (collision) {
      const stats = mergeDir(op.srcDir, dstDir);
      console.log(`${bold("Project dir:")} merged ${stats.moved} entries from ${dim(op.srcEncoded)}`);
      if (stats.conflicts.length > 0) {
        console.log(yellow("  Conflicts (kept destination): ") + stats.conflicts.slice(0, 5).join(", ") + (stats.conflicts.length > 5 ? ` (+${stats.conflicts.length - 5} more)` : ""));
      }
    } else {
      try {
        safeRename(op.srcDir, dstDir);
        console.log(`${bold("Project dir:")} renamed ${dim(op.srcEncoded)} → ${dstEncoded}`);
      } catch (e) {
        console.error(`${yellow("Error:")} Failed to rename ${op.srcDir}: ${(e as Error).message}`);
        process.exit(1);
      }
    }
  }

  for (const op of ops) {
    if (op.encodedNoop || !existsSync(op.srcCacheDir)) continue;
    const collision = existsSync(dstCacheDir);
    if (!apply) {
      console.log(`${bold("MCP cache dir:")} would ${collision ? "merge" : "rename"} ${dim(op.srcEncoded)} → ${dstEncoded}`);
    } else if (collision) {
      const stats = mergeDir(op.srcCacheDir, dstCacheDir);
      console.log(`${bold("MCP cache dir:")} merged ${stats.moved} entries from ${dim(op.srcEncoded)}`);
    } else {
      try {
        safeRename(op.srcCacheDir, dstCacheDir);
        console.log(`${bold("MCP cache dir:")} renamed ${dim(op.srcEncoded)} → ${dstEncoded}`);
      } catch (e) {
        console.error(`${yellow("Error:")} Failed to rename ${op.srcCacheDir}: ${(e as Error).message}`);
        process.exit(1);
      }
    }
  }

  if (apply) {
    for (const cfg of [CLAUDE_CONFIG, CLAUDE_CONFIG_BACKUP]) {
      let merged = 0;
      for (const op of ops) {
        if (await mergeClaudeJsonProjectsKey(cfg, op.src, dstAbs)) merged++;
      }
      if (merged > 0) console.log(`${bold("Merged")} ${merged} project key(s) in ${dim(cfg.split("/").pop() || cfg)}`);
    }
    console.log();
  }

  let scanned = 0, modified = 0, occurrences = 0, skippedBinary = 0;
  for await (const filePath of walkFiles(CLAUDE_HOME)) {
    const rel = filePath.replace(CLAUDE_HOME + "/", "");
    const r = await processFile(filePath, allPairs, compiled, rel, !apply, expectedShas);
    if (r.scanned) scanned++;
    if (r.binary) skippedBinary++;
    if (r.modified) { modified++; occurrences += r.count; }
  }
  for (const cfg of [CLAUDE_CONFIG, CLAUDE_CONFIG_BACKUP]) {
    if (!existsSync(cfg)) continue;
    const label = cfg.split("/").pop() || cfg;
    const r = await processFile(cfg, allPairs, compiled, label, !apply, expectedShas);
    if (r.scanned) scanned++;
    if (r.binary) skippedBinary++;
    if (r.modified) { modified++; occurrences += r.count; }
  }

  let projectScanned = 0, projectModified = 0, projectOccurrences = 0;
  if (!noProject && existsSync(dstAbs)) {
    const projectClaudeDir = dstAbs + "/.claude";
    if (existsSync(projectClaudeDir)) {
      for await (const filePath of walkFiles(projectClaudeDir)) {
        const rel = "[project] " + filePath.replace(dstAbs + "/", "");
        const r = await processFile(filePath, allPairs, compiled, rel, !apply, expectedShas);
        if (r.scanned) projectScanned++;
        if (r.modified) { projectModified++; projectOccurrences += r.count; }
      }
    }
    for (const name of [".mcp.json", "CLAUDE.md", "CLAUDE.local.md"]) {
      const p = dstAbs + "/" + name;
      if (!existsSync(p)) continue;
      const r = await processFile(p, allPairs, compiled, "[project] " + name, !apply, expectedShas);
      if (r.scanned) projectScanned++;
      if (r.modified) { projectModified++; projectOccurrences += r.count; }
    }
  }

  console.log(`\n${bold("Files:")} ${scanned} scanned, ${modified} ${apply ? "modified" : "would be modified"}, ${skippedBinary} binary skipped`);
  console.log(`${bold("Refs:")} ${occurrences} path occurrences ${apply ? "replaced" : "found"}`);
  if (projectScanned > 0) {
    console.log(`${bold("Project files:")} ${projectScanned} scanned, ${projectModified} ${apply ? "modified" : "would be modified"}, ${projectOccurrences} refs`);
  }

  if (apply) {
    let dbRows = 0;
    for (const op of ops) dbRows += await updateDatabase(op.src, dstAbs);
    if (dbRows > 0) console.log(`${bold("Database:")} ${dbRows} rows updated`);

    if (!noArchive) {
      const archived: string[] = [];
      for (const op of ops) {
        if (op.src === dstAbs) continue;
        if (!existsSync(op.src)) continue;
        try {
          const dst = archiveSourceDir(op.src);
          archived.push(`${op.src} → ${dst}`);
        } catch (e) {
          console.error(yellow("Warning:") + ` Failed to archive ${op.src}: ${(e as Error).message}`);
        }
      }
      if (archived.length > 0) {
        console.log(`\n${bold("Archived")} ${archived.length} source dir(s) to ${dim(BACKUP_DIR)}:`);
        for (const a of archived) console.log(`  ${a}`);
      }
    }

    if (expectedShas) {
      const v = await verifyApply(expectedShas, allPairs, dstDir);
      console.log(`\n${bold("Verify:")} ${v.shaChecked} SHAs matched`);
      if (v.shaMismatches.length > 0) {
        console.log(yellow(`  ${v.shaMismatches.length} SHA mismatch(es):`));
        for (const f of v.shaMismatches.slice(0, 10)) console.log(`    ${f}`);
        if (v.shaMismatches.length > 10) console.log(`    (+${v.shaMismatches.length - 10} more)`);
      }
      if (v.staleOldRefs.length > 0) {
        const total = v.staleOldRefs.reduce((s, r) => s + r.count, 0);
        console.log(yellow(`  ${v.staleOldRefs.length} file(s) still reference old paths (${total} occurrences):`));
        for (const r of v.staleOldRefs.slice(0, 5)) console.log(`    ${r.file.replace(CLAUDE_HOME + "/", "")} (${r.count})`);
        if (v.staleOldRefs.length > 5) console.log(`    (+${v.staleOldRefs.length - 5} more)`);
      }
      if (v.invalidJsonl.length > 0) {
        console.log(yellow(`  ${v.invalidJsonl.length} invalid JSONL file(s):`));
        for (const i of v.invalidJsonl.slice(0, 5)) console.log(`    ${i.file}:${i.line}`);
      }
      if (v.shaMismatches.length === 0 && v.staleOldRefs.length === 0 && v.invalidJsonl.length === 0) {
        console.log(`  ${dim("no stale old-path refs, all JSONL parses cleanly")}`);
      }
    }

    console.log(`\n${bold("Done.")} Run ${cyan("ccbase ingest --force")} to fully refresh.`);
  } else {
    console.log(`\nRun the same command with ${bold("--apply")} to commit.`);
  }
}
