import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Real-claude integration tests. Spawns `claude -p` to generate actual session
 * state, runs ccbase mv against the real ~/.claude/, asserts behavior, cleans up.
 *
 * Skipped automatically if `claude` is not on PATH.
 * Costs roughly a few cents in API tokens per run.
 */

const CCBASE = join(import.meta.dir, "..", "src", "index.ts");
const HOME = process.env.HOME!;
const REAL_CLAUDE_HOME = join(HOME, ".claude");
const PROJECTS_DIR = join(REAL_CLAUDE_HOME, "projects");
const CACHE_DIR = join(HOME, "Library/Caches/claude-cli-nodejs");
const CLAUDE_JSON = join(HOME, ".claude.json");
const HISTORY_JSONL = join(REAL_CLAUDE_HOME, "history.jsonl");

const claudeAvailable = (() => {
  const r = Bun.spawnSync(["bash", "-lc", "command -v claude"]);
  return r.exitCode === 0;
})();

function realpathSafe(p: string): string {
  try { return realpathSync(p); } catch {}
  const lastSep = p.lastIndexOf("/");
  if (lastSep <= 0) return p;
  try { return realpathSync(p.slice(0, lastSep)) + "/" + p.slice(lastSep + 1); } catch {}
  return p;
}

function encode(absPath: string): string {
  return realpathSafe(absPath).replace(/\./g, "-").replace(/\//g, "-");
}

interface ClaudeResult {
  code: number;
  sessionId: string | null;
  result: string;
  stderr: string;
}

async function runClaude(cwd: string, prompt: string, opts: { resume?: string } = {}): Promise<ClaudeResult> {
  const args = ["-p", prompt, "--output-format", "json"];
  if (opts.resume) args.push("--resume", opts.resume);
  const proc = Bun.spawn(["bash", "-lc", `claude ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`], {
    cwd, stdout: "pipe", stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  let sessionId: string | null = null;
  let result = "";
  try {
    const json = JSON.parse(stdout);
    sessionId = json.session_id ?? null;
    result = json.result ?? "";
  } catch {}
  return { code, sessionId, result, stderr };
}

async function runCcbase(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CCBASE, ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

const TS = Date.now();
const ROOT = `/tmp/ccbase-real-${TS}`;
const createdEncoded = new Set<string>();
const createdPaths = new Set<string>();
const backupsBeforeTests = new Set<string>();

function trackProject(absPath: string) {
  createdEncoded.add(encode(absPath));
  createdPaths.add(realpathSafe(absPath));
}

beforeAll(() => {
  if (!claudeAvailable) return;
  mkdirSync(ROOT, { recursive: true });
  if (existsSync(join(REAL_CLAUDE_HOME, "backups"))) {
    for (const b of readdirSync(join(REAL_CLAUDE_HOME, "backups"))) backupsBeforeTests.add(b);
  }
});

afterAll(() => {
  if (!claudeAvailable) return;
  // Physical /tmp root
  if (existsSync(ROOT)) {
    try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
  }
  // Encoded project dirs we created (rename targets included)
  for (const enc of createdEncoded) {
    const p = join(PROJECTS_DIR, enc);
    if (existsSync(p)) {
      try { rmSync(p, { recursive: true, force: true }); } catch {}
    }
    const cp = join(CACHE_DIR, enc);
    if (existsSync(cp)) {
      try { rmSync(cp, { recursive: true, force: true }); } catch {}
    }
  }
  // Backup tarballs created during tests
  const backupsDir = join(REAL_CLAUDE_HOME, "backups");
  if (existsSync(backupsDir)) {
    for (const b of readdirSync(backupsDir)) {
      if (!backupsBeforeTests.has(b) && b.startsWith("ccbase-mv-")) {
        try { rmSync(join(backupsDir, b)); } catch {}
      }
    }
  }
  // .claude.json: remove our test entries
  if (existsSync(CLAUDE_JSON)) {
    try {
      const j = JSON.parse(readFileSync(CLAUDE_JSON, "utf-8"));
      if (j.projects) {
        let changed = false;
        for (const key of Object.keys(j.projects)) {
          if (createdPaths.has(key) || key.includes(`ccbase-real-${TS}`)) {
            delete j.projects[key];
            changed = true;
          }
        }
        if (changed) writeFileSync(CLAUDE_JSON, JSON.stringify(j, null, 2));
      }
    } catch {}
  }
});

const skip = !claudeAvailable;
const itReal = skip ? test.skip : test;

describe("real claude integration", () => {
  if (skip) {
    test.skip("claude binary not found — install Claude Code CLI to run these tests", () => {});
    return;
  }

  itReal("rename: claude session moves to new encoded dir with rewritten cwd", async () => {
    const old = join(ROOT, "rename-old");
    const fresh = join(ROOT, "rename-new");
    mkdirSync(old);
    trackProject(old);
    trackProject(fresh);

    const r = await runClaude(old, "Reply with exactly: TEST_RENAME_OK");
    expect(r.code).toBe(0);
    expect(r.sessionId).toBeTruthy();
    expect(r.result).toContain("TEST_RENAME_OK");

    const oldEnc = encode(old);
    const newEnc = encode(fresh);
    const oldSessionFile = join(PROJECTS_DIR, oldEnc, `${r.sessionId}.jsonl`);
    expect(existsSync(oldSessionFile)).toBe(true);

    Bun.spawnSync(["mv", old, fresh]);
    expect(existsSync(fresh)).toBe(true);

    const mv = await runCcbase(["mv", old, fresh, "--apply", "--no-backup"]);
    expect(mv.code).toBe(0);

    expect(existsSync(join(PROJECTS_DIR, oldEnc))).toBe(false);
    const newSessionFile = join(PROJECTS_DIR, newEnc, `${r.sessionId}.jsonl`);
    expect(existsSync(newSessionFile)).toBe(true);

    const realFresh = realpathSafe(fresh);
    const realOld = realpathSafe(old);
    const content = readFileSync(newSessionFile, "utf-8");
    expect(content).toContain(realFresh);
    expect(content).not.toContain(realOld);
  }, 90000);

  itReal("resume works after rename: --resume loads the moved session", async () => {
    const old = join(ROOT, "resume-old");
    const fresh = join(ROOT, "resume-new");
    mkdirSync(old);
    trackProject(old);
    trackProject(fresh);

    const r1 = await runClaude(old, "Remember the marker word: PURPLE_ELEPHANT_42. Reply OK.");
    expect(r1.code).toBe(0);
    const sessionId = r1.sessionId!;

    Bun.spawnSync(["mv", old, fresh]);
    const mv = await runCcbase(["mv", old, fresh, "--apply", "--no-backup"]);
    expect(mv.code).toBe(0);

    const r2 = await runClaude(fresh, "What was the marker word I told you to remember? Reply with just the marker word.", { resume: sessionId });
    expect(r2.code).toBe(0);
    expect(r2.result).toContain("PURPLE_ELEPHANT_42");
  }, 180000);

  itReal("project-local rewrite: CLAUDE.md and .mcp.json updated after mv", async () => {
    const old = join(ROOT, "local-old");
    const fresh = join(ROOT, "local-new");
    mkdirSync(old);
    trackProject(old);
    trackProject(fresh);

    writeFileSync(join(old, "CLAUDE.md"), `# Test\n\nProject lives at ${old}\nSee ${old}/notes.md\n`);
    writeFileSync(join(old, ".mcp.json"), JSON.stringify({ mcpServers: { dummy: { command: "echo", args: [old] } } }, null, 2));
    writeFileSync(join(old, "notes.md"), "Hello");

    const r = await runClaude(old, "Reply with exactly: TEST_LOCAL_OK");
    expect(r.code).toBe(0);

    Bun.spawnSync(["mv", old, fresh]);
    const mv = await runCcbase(["mv", old, fresh, "--apply", "--no-backup"]);
    expect(mv.code).toBe(0);

    const realFresh = realpathSafe(fresh);
    const realOld = realpathSafe(old);

    const claudeMd = readFileSync(join(fresh, "CLAUDE.md"), "utf-8");
    expect(claudeMd.includes(fresh) || claudeMd.includes(realFresh)).toBe(true);
    expect(claudeMd).not.toContain(old + "/");
    expect(claudeMd).not.toContain(realOld + "/");

    const mcpJson = readFileSync(join(fresh, ".mcp.json"), "utf-8");
    expect(mcpJson.includes(fresh) || mcpJson.includes(realFresh)).toBe(true);
    expect(mcpJson).not.toContain(old + "/");
    expect(mcpJson).not.toContain(realOld + "/");
  }, 90000);

  itReal("merge: two real projects combine into one with --merge", async () => {
    const a = join(ROOT, "merge-a");
    const b = join(ROOT, "merge-b");
    mkdirSync(a);
    mkdirSync(b);
    trackProject(a);
    trackProject(b);

    const rA = await runClaude(a, "Reply with exactly: SESSION_A");
    const rB = await runClaude(b, "Reply with exactly: SESSION_B");
    expect(rA.code).toBe(0);
    expect(rB.code).toBe(0);

    const aEnc = encode(a);
    const bEnc = encode(b);
    const aSession = join(PROJECTS_DIR, aEnc, `${rA.sessionId}.jsonl`);
    const bSession = join(PROJECTS_DIR, bEnc, `${rB.sessionId}.jsonl`);
    expect(existsSync(aSession)).toBe(true);
    expect(existsSync(bSession)).toBe(true);

    rmSync(b, { recursive: true });
    Bun.spawnSync(["mv", a, b]);

    const mv = await runCcbase(["mv", a, b, "--merge", "--apply", "--no-backup"]);
    expect(mv.code).toBe(0);

    expect(existsSync(join(PROJECTS_DIR, aEnc))).toBe(false);
    const bDir = readdirSync(join(PROJECTS_DIR, bEnc));
    expect(bDir).toContain(`${rA.sessionId}.jsonl`);
    expect(bDir).toContain(`${rB.sessionId}.jsonl`);

    const realB = realpathSafe(b);
    const realA = realpathSafe(a);
    const movedContent = readFileSync(join(PROJECTS_DIR, bEnc, `${rA.sessionId}.jsonl`), "utf-8");
    expect(movedContent).toContain(realB);
    expect(movedContent).not.toContain(realA);
  }, 120000);

  itReal("backup tarball created on apply and contains the source encoded dir", async () => {
    const old = join(ROOT, "backup-old");
    const fresh = join(ROOT, "backup-new");
    mkdirSync(old);
    trackProject(old);
    trackProject(fresh);

    const r = await runClaude(old, "Reply with exactly: BACKUP_TEST");
    expect(r.code).toBe(0);

    Bun.spawnSync(["mv", old, fresh]);

    const before = readdirSync(join(REAL_CLAUDE_HOME, "backups")).filter(b => b.startsWith("ccbase-mv-"));
    const mv = await runCcbase(["mv", old, fresh, "--apply"]);
    expect(mv.code).toBe(0);

    const after = readdirSync(join(REAL_CLAUDE_HOME, "backups")).filter(b => b.startsWith("ccbase-mv-"));
    const newOnes = after.filter(b => !before.includes(b));
    expect(newOnes).toHaveLength(1);

    const tarPath = join(REAL_CLAUDE_HOME, "backups", newOnes[0]);
    const list = Bun.spawnSync(["tar", "-tzf", tarPath]);
    const listing = new TextDecoder().decode(list.stdout);
    expect(listing).toContain(encode(old));
    expect(statSync(tarPath).size).toBeGreaterThan(0);
  }, 90000);

  itReal("dry-run leaves real state untouched", async () => {
    const old = join(ROOT, "dry-old");
    const fresh = join(ROOT, "dry-new");
    mkdirSync(old);
    trackProject(old);
    trackProject(fresh);

    const r = await runClaude(old, "Reply with exactly: DRY");
    expect(r.code).toBe(0);
    const oldEnc = encode(old);
    const sessionFile = join(PROJECTS_DIR, oldEnc, `${r.sessionId}.jsonl`);
    const sizeBefore = statSync(sessionFile).size;
    const contentBefore = readFileSync(sessionFile, "utf-8");

    Bun.spawnSync(["mv", old, fresh]);

    const mv = await runCcbase(["mv", old, fresh]);
    expect(mv.code).toBe(0);
    expect(mv.stdout).toContain("DRY RUN");

    expect(existsSync(join(PROJECTS_DIR, oldEnc))).toBe(true);
    expect(existsSync(sessionFile)).toBe(true);
    expect(statSync(sessionFile).size).toBe(sizeBefore);
    expect(readFileSync(sessionFile, "utf-8")).toBe(contentBefore);
  }, 60000);
});
