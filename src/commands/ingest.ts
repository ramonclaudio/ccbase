import { runIngest } from "../ingest/index.ts";

export async function ingestCommand(args: string[]): Promise<void> {
  const force = args.includes("--force");
  const cron = args.includes("--cron");
  const removeCron = args.includes("--no-cron");

  if (removeCron) {
    await Bun.cron.remove("claude-pulse-ingest");
    console.log("Removed auto-ingest cron job.");
    return;
  }

  if (cron) {
    const schedule = args.find(a => /^[\d*\/,-]+\s/.test(a)) || "7 * * * *";
    await Bun.cron(import.meta.path, schedule, "claude-pulse-ingest");
    const next = Bun.cron.parse(schedule);
    console.log(`Auto-ingest scheduled: ${schedule}`);
    console.log(`Next run: ${next?.toLocaleString() || "unknown"}`);
    return;
  }

  await runIngest(force);
}

// Bun.cron scheduled handler
export default {
  async scheduled() {
    await runIngest(false);
  },
};
