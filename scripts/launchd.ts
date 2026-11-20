import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { installAgent, uninstallAgent, type AgentOptions } from "../src/ops/launchd.js";

const projectDir = process.cwd();
const options: AgentOptions = {
  platform: process.platform,
  home: homedir(),
  uid: process.getuid?.() ?? 0,
  label: "com.fuse.agent",
  nodePath: process.execPath,
  projectDir,
  logDir: join(projectDir, "data", "logs"),
  run: (cmd, args) =>
    new Promise<void>((resolve, reject) => {
      execFile(cmd, args, (err, _stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()));
    }),
  write: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  },
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  remove: (path) => rmSync(path, { force: true }),
};

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === "install") {
    const path = await installAgent(options);
    console.log(`Fuse is installed and running in the background (${path}).\nLogs: ${options.logDir}`);
  } else if (action === "uninstall") {
    await uninstallAgent(options);
    console.log("Fuse is stopped and will no longer start automatically.");
  } else {
    throw new Error("Usage: tsx scripts/launchd.ts install|uninstall");
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
