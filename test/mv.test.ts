import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

const CCBASE = join(import.meta.dir, "..", "src", "index.ts");

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

interface FixtureOpts {
  sessions?: number;
  withSubagent?: boolean;
  withMcpJson?: boolean;
  withClaudeMd?: boolean;
  withProjectSettings?: boolean;
  historyEntries?: number;
  cacheDir?: boolean;
  projectsJsonEntry?: Record<string, unknown>;
}

interface Fixture {
  home: string;
  cwd: string;
  encoded: string;
  sessionIds: string[];
}

function setupHome(): string {
  const home = realpathSafe(mkdtempSync("/tmp/ccbase-test-home-"));
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(join(home, ".claude", "backups"), { recursive: true });
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  mkdirSync(join(home, "Library", "Caches", "claude-cli-nodejs"), { recursive: true });
  return home;
}

function makeProject(home: string, cwdGiven: string, opts: FixtureOpts = {}): Fixture {
  mkdirSync(cwdGiven, { recursive: true });
  const cwd = realpathSafe(cwdGiven);
  const encoded = encode(cwd);
  const projDir = join(home, ".claude", "projects", encoded);
  mkdirSync(projDir, { recursive: true });

  const sessionIds: string[] = [];
  const count = opts.sessions ?? 1;
  for (let i = 0; i < count; i++) {
    const sid = crypto.randomUUID();
    sessionIds.push(sid);
    const lines = [
      JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: sid }),
      JSON.stringify({ type: "file-history-snapshot", messageId: `msg-${sid}-1`, snapshot: { messageId: `msg-${sid}-1`, trackedFileBackups: {}, timestamp: "2026-01-01T00:00:00Z" }, isSnapshotUpdate: false }),
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: `Test in ${cwd}` }, uuid: `msg-${sid}-1`, cwd, sessionId: sid, version: "2.1.143" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: `I'm working at path: ${cwd}/src/main.ts` }, parentUuid: `msg-${sid}-1`, uuid: `msg-${sid}-2`, cwd, sessionId: sid }),
    ];
    writeFileSync(join(projDir, `${sid}.jsonl`), lines.join("\n") + "\n");

    if (opts.withSubagent) {
      const subagentDir = join(projDir, sid, "subagents");
      const toolResultsDir = join(projDir, sid, "tool-results");
      mkdirSync(subagentDir, { recursive: true });
      mkdirSync(toolResultsDir, { recursive: true });
      const agentId = `a${Math.random().toString(16).slice(2, 18)}`;
      writeFileSync(
        join(subagentDir, `agent-${agentId}.jsonl`),
        JSON.stringify({ type: "user", cwd, message: { content: `Subagent task: read ${cwd}/README.md` }, sessionId: sid }) + "\n",
      );
      writeFileSync(
        join(subagentDir, `agent-${agentId}.meta.json`),
        JSON.stringify({ cwd, sessionId: sid, status: "completed" }),
      );
      writeFileSync(
        join(toolResultsDir, "toolu_test.txt"),
        `Output from ${cwd}/script.sh:\nHello from ${cwd}\n`,
      );
    }
  }

  if (opts.withMcpJson) {
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "node", args: [`${cwd}/server.js`], cwd } } }, null, 2),
    );
  }
  if (opts.withClaudeMd) {
    writeFileSync(join(cwd, "CLAUDE.md"), `# Notes\n\nSee @${cwd}/docs/api.md for the full API.\nRun \`${cwd}/scripts/dev.sh\` to start.\n`);
  }
  if (opts.withProjectSettings) {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify(
        {
          permissions: { allow: [`Bash(node ${cwd}/build.js)`] },
          hooks: {
            PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: `${cwd}/.claude/hooks/lint.sh` }] }],
          },
        },
        null,
        2,
      ),
    );
  }

  const claudeJsonPath = join(home, ".claude.json");
  let json: { projects?: Record<string, unknown> } = {};
  if (existsSync(claudeJsonPath)) {
    json = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
  }
  json.projects = json.projects || {};
  json.projects[cwd] = opts.projectsJsonEntry ?? {
    hasTrustDialogAccepted: true,
    allowedTools: [`Read(${cwd}/**)`],
    mcpServers: {},
    lastCost: 0.0123,
  };
  writeFileSync(claudeJsonPath, JSON.stringify(json, null, 2));

  if (opts.historyEntries) {
    const historyPath = join(home, ".claude", "history.jsonl");
    const existing = existsSync(historyPath) ? readFileSync(historyPath, "utf-8") : "";
    const entries = Array.from({ length: opts.historyEntries }, (_, i) =>
      JSON.stringify({ display: `/test${i}`, project: cwd, sessionId: sessionIds[0], timestamp: Date.now() + i }),
    ).join("\n");
    writeFileSync(historyPath, existing + entries + "\n");
  }

  if (opts.cacheDir) {
    const cacheProjDir = join(home, "Library", "Caches", "claude-cli-nodejs", encoded, "mcp-logs-test");
    mkdirSync(cacheProjDir, { recursive: true });
    writeFileSync(join(cacheProjDir, "2026-01-01T00-00-00Z.jsonl"), JSON.stringify({ cwd, level: "info" }) + "\n");
  }

  return { home, cwd, encoded, sessionIds };
}

async function runCcbase(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CCBASE, ...args], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf-8").trim().split("\n").map(l => JSON.parse(l));
}

let activeHome: string | null = null;
afterEach(() => {
  if (activeHome) {
    try { rmSync(activeHome, { recursive: true, force: true }); } catch {}
    activeHome = null;
  }
});

describe("dry-run default", () => {
  test("no --apply means no writes", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/foo");
    const dst = join(activeHome, "Developer/bar");
    makeProject(activeHome, src);
    mkdirSync(dst, { recursive: true });

    const r = await runCcbase(activeHome, ["mv", src, dst]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("DRY RUN");
    expect(r.stdout).toContain("Run the same command with");

    // No physical changes
    expect(existsSync(join(activeHome, ".claude/projects", encode(src)))).toBe(true);
    expect(existsSync(join(activeHome, ".claude/projects", encode(dst)))).toBe(false);

    // .claude.json untouched
    const json = JSON.parse(readFileSync(join(activeHome, ".claude.json"), "utf-8"));
    expect(json.projects[src]).toBeDefined();
    expect(json.projects[dst]).toBeUndefined();
  });
});

describe("simple rename", () => {
  test("project dir renamed and contents rewritten", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/old-project");
    const dst = join(activeHome, "Developer/new-project");
    const f = makeProject(activeHome, src, { withSubagent: true, historyEntries: 3, cacheDir: true });
    mkdirSync(dst, { recursive: true });

    const r = await runCcbase(activeHome, ["mv", src, dst, "--apply", "--no-backup"]);
    expect(r.code).toBe(0);

    // Project dir renamed
    expect(existsSync(join(activeHome, ".claude/projects", encode(src)))).toBe(false);
    expect(existsSync(join(activeHome, ".claude/projects", encode(dst)))).toBe(true);

    // Session JSONL has rewritten cwd
    const sessionFile = join(activeHome, ".claude/projects", encode(dst), `${f.sessionIds[0]}.jsonl`);
    const lines = readJsonl(sessionFile);
    const userLine = lines.find(l => l.type === "user" && l.cwd) as { cwd: string };
    expect(userLine.cwd).toBe(dst);
    expect(JSON.stringify(lines)).not.toContain(src);

    // Subagent + tool-results rewritten
    const sid = f.sessionIds[0];
    const subagentDir = join(activeHome, ".claude/projects", encode(dst), sid, "subagents");
    const agentFiles = readdirSync(subagentDir);
    const agentJsonl = agentFiles.find(f => f.endsWith(".jsonl"))!;
    const agentContent = readFileSync(join(subagentDir, agentJsonl), "utf-8");
    expect(agentContent).toContain(dst);
    expect(agentContent).not.toContain(src);

    const toolResults = join(activeHome, ".claude/projects", encode(dst), sid, "tool-results", "toolu_test.txt");
    expect(readFileSync(toolResults, "utf-8")).not.toContain(src);

    // history.jsonl rewritten
    const history = readFileSync(join(activeHome, ".claude/history.jsonl"), "utf-8");
    expect(history).toContain(`"project":"${dst}"`);
    expect(history).not.toContain(`"project":"${src}"`);

    // .claude.json projects key swapped
    const json = JSON.parse(readFileSync(join(activeHome, ".claude.json"), "utf-8"));
    expect(json.projects[dst]).toBeDefined();
    expect(json.projects[src]).toBeUndefined();

    // MCP cache dir renamed
    expect(existsSync(join(activeHome, "Library/Caches/claude-cli-nodejs", encode(src)))).toBe(false);
    expect(existsSync(join(activeHome, "Library/Caches/claude-cli-nodejs", encode(dst)))).toBe(true);
  });
});

describe("project-local rewriting", () => {
  test("rewrites .mcp.json, CLAUDE.md, and .claude/settings.json", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/alpha");
    const dst = join(activeHome, "Developer/zeta");
    makeProject(activeHome, src, { withMcpJson: true, withClaudeMd: true, withProjectSettings: true });

    // Simulate physical move: copy project content to dst, remove src
    mkdirSync(dst, { recursive: true });
    Bun.spawnSync(["cp", "-R", src + "/.", dst]);
    rmSync(src, { recursive: true, force: true });

    const r = await runCcbase(activeHome, ["mv", src, dst, "--apply", "--no-backup"]);
    expect(r.code).toBe(0);

    const mcpJson = readFileSync(join(dst, ".mcp.json"), "utf-8");
    expect(mcpJson).toContain(dst);
    expect(mcpJson).not.toContain(src);

    const claudeMd = readFileSync(join(dst, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain(dst);
    expect(claudeMd).not.toContain(src);

    const settings = readFileSync(join(dst, ".claude/settings.json"), "utf-8");
    expect(settings).toContain(dst);
    expect(settings).not.toContain(src);
  });

  test("--no-project skips project-local walk", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/alpha");
    const dst = join(activeHome, "Developer/zeta");
    makeProject(activeHome, src, { withClaudeMd: true });
    mkdirSync(dst, { recursive: true });
    Bun.spawnSync(["cp", "-R", src + "/.", dst]);
    rmSync(src, { recursive: true, force: true });

    const r = await runCcbase(activeHome, ["mv", src, dst, "--apply", "--no-backup", "--no-project"]);
    expect(r.code).toBe(0);

    const claudeMd = readFileSync(join(dst, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain(src);
  });
});

describe("collision handling", () => {
  test("refuses without --merge when destination project dir exists", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/src");
    const dst = join(activeHome, "Developer/dst");
    makeProject(activeHome, src);
    makeProject(activeHome, dst);

    const r = await runCcbase(activeHome, ["mv", src, dst, "--apply"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Pass --merge");
  });

  test("--merge combines sessions from both", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/src");
    const dst = join(activeHome, "Developer/dst");
    const fSrc = makeProject(activeHome, src, { sessions: 2 });
    const fDst = makeProject(activeHome, dst, { sessions: 1 });

    const r = await runCcbase(activeHome, ["mv", src, dst, "--merge", "--apply", "--no-backup"]);
    expect(r.code).toBe(0);

    // Source dir gone
    expect(existsSync(join(activeHome, ".claude/projects", encode(src)))).toBe(false);

    // Destination has all 3 session files
    const dstFiles = readdirSync(join(activeHome, ".claude/projects", encode(dst))).filter(f => f.endsWith(".jsonl"));
    expect(dstFiles).toHaveLength(3);
    for (const sid of [...fSrc.sessionIds, ...fDst.sessionIds]) {
      expect(dstFiles).toContain(`${sid}.jsonl`);
    }

    // Source-session content rewritten to dst path
    const movedSession = join(activeHome, ".claude/projects", encode(dst), `${fSrc.sessionIds[0]}.jsonl`);
    const lines = readJsonl(movedSession);
    const userLine = lines.find(l => l.type === "user" && l.cwd) as { cwd: string };
    expect(userLine.cwd).toBe(dst);
  });
});

describe("N-to-1 merge", () => {
  test("three sources combined into one destination", async () => {
    activeHome = setupHome();
    const a = join(activeHome, "Developer/a");
    const b = join(activeHome, "Developer/b");
    const c = join(activeHome, "Developer/c");
    const fA = makeProject(activeHome, a, { sessions: 2 });
    const fB = makeProject(activeHome, b, { sessions: 1 });
    const fC = makeProject(activeHome, c, { sessions: 1 });

    const r = await runCcbase(activeHome, ["mv", a, b, c, "--merge", "--apply", "--no-backup"]);
    expect(r.code).toBe(0);

    // a, b gone; c has all 4 sessions
    expect(existsSync(join(activeHome, ".claude/projects", encode(a)))).toBe(false);
    expect(existsSync(join(activeHome, ".claude/projects", encode(b)))).toBe(false);
    const cFiles = readdirSync(join(activeHome, ".claude/projects", encode(c))).filter(f => f.endsWith(".jsonl"));
    expect(cFiles).toHaveLength(4);
    for (const sid of [...fA.sessionIds, ...fB.sessionIds, ...fC.sessionIds]) {
      expect(cFiles).toContain(`${sid}.jsonl`);
    }

    // All cwds in moved sessions point to c
    for (const sid of [...fA.sessionIds, ...fB.sessionIds]) {
      const lines = readJsonl(join(activeHome, ".claude/projects", encode(c), `${sid}.jsonl`));
      const user = lines.find(l => l.type === "user" && l.cwd) as { cwd: string };
      expect(user.cwd).toBe(c);
    }

    // .claude.json: only c key remains
    const json = JSON.parse(readFileSync(join(activeHome, ".claude.json"), "utf-8"));
    expect(json.projects[c]).toBeDefined();
    expect(json.projects[a]).toBeUndefined();
    expect(json.projects[b]).toBeUndefined();
  });
});

describe(".claude.json deep-merge", () => {
  test("merging two project keys unions arrays and merges objects (destination wins for scalars)", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/src");
    const dst = join(activeHome, "Developer/dst");
    makeProject(activeHome, src, {
      projectsJsonEntry: {
        allowedTools: ["Read", "Write"],
        mcpServers: { serverA: { command: "a" }, shared: { command: "src-shared" } },
        hasTrustDialogAccepted: false,
        lastCost: 0.5,
      },
    });
    makeProject(activeHome, dst, {
      projectsJsonEntry: {
        allowedTools: ["Read", "Bash"],
        mcpServers: { serverB: { command: "b" }, shared: { command: "dst-shared" } },
        hasTrustDialogAccepted: true,
        lastCost: 0.1,
      },
    });

    const r = await runCcbase(activeHome, ["mv", src, dst, "--merge", "--apply", "--no-backup"]);
    expect(r.code).toBe(0);

    const json = JSON.parse(readFileSync(join(activeHome, ".claude.json"), "utf-8"));
    const entry = json.projects[dst];
    expect(entry).toBeDefined();
    expect(json.projects[src]).toBeUndefined();

    // arrays union
    expect(new Set(entry.allowedTools)).toEqual(new Set(["Read", "Write", "Bash"]));

    // objects deep-merge with dst winning on conflicting subkeys
    expect(entry.mcpServers.serverA).toEqual({ command: "a" });
    expect(entry.mcpServers.serverB).toEqual({ command: "b" });
    expect(entry.mcpServers.shared).toEqual({ command: "dst-shared" });

    // scalars dst wins
    expect(entry.hasTrustDialogAccepted).toBe(true);
    expect(entry.lastCost).toBe(0.1);
  });
});

describe("backup", () => {
  test("apply creates tarball in ~/.claude/backups/", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/src");
    const dst = join(activeHome, "Developer/dst");
    makeProject(activeHome, src);
    mkdirSync(dst, { recursive: true });

    const r = await runCcbase(activeHome, ["mv", src, dst, "--apply"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Backup:");

    const backups = readdirSync(join(activeHome, ".claude/backups")).filter(f => f.startsWith("ccbase-mv-") && f.endsWith(".tar.gz"));
    expect(backups).toHaveLength(1);

    const tarPath = join(activeHome, ".claude/backups", backups[0]);
    const stat = Bun.spawnSync(["tar", "-tzf", tarPath]);
    const contents = new TextDecoder().decode(stat.stdout);
    expect(contents).toContain(encode(src));
  });

  test("--no-backup skips tarball", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/src");
    const dst = join(activeHome, "Developer/dst");
    makeProject(activeHome, src);
    mkdirSync(dst, { recursive: true });

    const r = await runCcbase(activeHome, ["mv", src, dst, "--apply", "--no-backup"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Backup:");

    const backups = readdirSync(join(activeHome, ".claude/backups")).filter(f => f.startsWith("ccbase-mv-"));
    expect(backups).toHaveLength(0);
  });
});

describe("path safety", () => {
  test("source and destination identical → error", async () => {
    activeHome = setupHome();
    const p = join(activeHome, "Developer/same");
    makeProject(activeHome, p);
    const r = await runCcbase(activeHome, ["mv", p, p, "--apply"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("identical to the destination");
  });

  test("destination does not exist → error", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/src");
    makeProject(activeHome, src);
    const r = await runCcbase(activeHome, ["mv", src, "/nonexistent/path/does/not/exist", "--apply"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("does not exist on disk");
  });

  test("source is ancestor of CLAUDE_HOME → error", async () => {
    activeHome = setupHome();
    const dst = join(activeHome, "Developer/dst");
    mkdirSync(dst, { recursive: true });
    // Try to move HOME itself, which contains ~/.claude
    const r = await runCcbase(activeHome, ["mv", activeHome, dst, "--apply"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ancestor of");
  });

  test("destination is inside source → error", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/parent");
    const dst = join(src, "child");
    makeProject(activeHome, src);
    mkdirSync(dst, { recursive: true });
    const r = await runCcbase(activeHome, ["mv", src, dst, "--apply"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("inside source");
  });
});

describe("source on disk warning", () => {
  test("warns when source still exists physically", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/src");
    const dst = join(activeHome, "Developer/dst");
    makeProject(activeHome, src);
    mkdirSync(dst, { recursive: true });
    // Note: src is still on disk

    const r = await runCcbase(activeHome, ["mv", src, dst]);
    expect(r.stdout).toContain("Source still exists on disk");
  });
});

describe("word-boundary regex", () => {
  test("does not rewrite sibling paths sharing a prefix", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/app");
    const dst = join(activeHome, "Developer/app-new");
    const sibling = join(activeHome, "Developer/app-v2");
    makeProject(activeHome, src);
    makeProject(activeHome, sibling);
    mkdirSync(dst, { recursive: true });

    const r = await runCcbase(activeHome, ["mv", src, dst, "--apply", "--no-backup"]);
    expect(r.code).toBe(0);

    // app-v2 entry should still exist untouched
    const json = JSON.parse(readFileSync(join(activeHome, ".claude.json"), "utf-8"));
    expect(json.projects[sibling]).toBeDefined();
    expect(existsSync(join(activeHome, ".claude/projects", encode(sibling)))).toBe(true);
  });
});

describe("archive source physical dirs", () => {
  test("apply moves source physical dirs to CCBASE_BACKUP_DIR by default", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/src");
    const dst = join(activeHome, "Developer/dst");
    makeProject(activeHome, src);
    mkdirSync(dst, { recursive: true });

    const backupDir = join(activeHome, "test-backups");
    const proc = Bun.spawn(["bun", "run", CCBASE, "mv", src, dst, "--apply", "--no-backup"], {
      env: { ...process.env, HOME: activeHome, CCBASE_BACKUP_DIR: backupDir },
      stdout: "pipe", stderr: "pipe",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(stdout).toContain("Archived");

    expect(existsSync(src)).toBe(false);
    const archived = readdirSync(backupDir);
    expect(archived.length).toBe(1);
    expect(archived[0]).toMatch(/^src-Developer-\d{4}-\d{2}-\d{2}/);
  });

  test("--no-archive leaves source physical dirs in place", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/src");
    const dst = join(activeHome, "Developer/dst");
    makeProject(activeHome, src);
    mkdirSync(dst, { recursive: true });

    const backupDir = join(activeHome, "test-backups");
    const proc = Bun.spawn(["bun", "run", CCBASE, "mv", src, dst, "--apply", "--no-backup", "--no-archive"], {
      env: { ...process.env, HOME: activeHome, CCBASE_BACKUP_DIR: backupDir },
      stdout: "pipe", stderr: "pipe",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(stdout).not.toContain("Archived");
    expect(existsSync(src)).toBe(true);
    expect(existsSync(backupDir)).toBe(false);
  });

  test("collision-safe naming when multiple sources share a basename", async () => {
    activeHome = setupHome();
    const a = join(activeHome, "Developer/alpha/repo");
    const b = join(activeHome, "Developer/beta/repo");
    const dst = join(activeHome, "Developer/merged");
    makeProject(activeHome, a);
    makeProject(activeHome, b);
    mkdirSync(dst, { recursive: true });

    const backupDir = join(activeHome, "test-backups");
    const proc = Bun.spawn(["bun", "run", CCBASE, "mv", a, b, dst, "--merge", "--apply", "--no-backup"], {
      env: { ...process.env, HOME: activeHome, CCBASE_BACKUP_DIR: backupDir },
      stdout: "pipe", stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).toBe(0);

    const archived = readdirSync(backupDir).sort();
    expect(archived.length).toBe(2);
    expect(archived.some(n => n.startsWith("repo-alpha-"))).toBe(true);
    expect(archived.some(n => n.startsWith("repo-beta-"))).toBe(true);
  });
});

describe("recursive merge", () => {
  test("merging colliding subdirs recurses into them (preserves all log files)", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/src");
    const dst = join(activeHome, "Developer/dst");
    makeProject(activeHome, src);
    makeProject(activeHome, dst);

    const srcEnc = encode(src);
    const dstEnc = encode(dst);
    const srcLogDir = join(activeHome, "Library/Caches/claude-cli-nodejs", srcEnc, "mcp-logs-test");
    const dstLogDir = join(activeHome, "Library/Caches/claude-cli-nodejs", dstEnc, "mcp-logs-test");
    mkdirSync(srcLogDir, { recursive: true });
    mkdirSync(dstLogDir, { recursive: true });
    writeFileSync(join(srcLogDir, "src-1.jsonl"), `{"src":1}\n`);
    writeFileSync(join(srcLogDir, "src-2.jsonl"), `{"src":2}\n`);
    writeFileSync(join(dstLogDir, "dst-1.jsonl"), `{"dst":1}\n`);

    const r = await runCcbase(activeHome, ["mv", src, dst, "--merge", "--apply", "--no-backup"]);
    expect(r.code).toBe(0);

    expect(existsSync(srcLogDir)).toBe(false);
    const merged = readdirSync(dstLogDir).sort();
    expect(merged).toEqual(["dst-1.jsonl", "src-1.jsonl", "src-2.jsonl"]);
  });
});

describe("idempotency", () => {
  test("running apply twice produces no second-pass changes", async () => {
    activeHome = setupHome();
    const src = join(activeHome, "Developer/src");
    const dst = join(activeHome, "Developer/dst");
    makeProject(activeHome, src);
    mkdirSync(dst, { recursive: true });

    const first = await runCcbase(activeHome, ["mv", src, dst, "--apply", "--no-backup"]);
    expect(first.code).toBe(0);

    const second = await runCcbase(activeHome, ["mv", src, dst, "--apply", "--no-backup"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/0 modified|already renamed or not found/);
  });
});
