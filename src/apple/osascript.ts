import { execFile as nodeExecFile } from "node:child_process";

/** Runs a JXA script with a JSON payload and returns what it printed. Data goes in the payload, never into the script text. */
export type ScriptRunner = (script: string, payload: unknown) => Promise<string>;

export class AppleUnavailableError extends Error {
  constructor(message = "Apple apps are only available on macOS") {
    super(message);
    this.name = "AppleUnavailableError";
  }
}

type ExecFileFn = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
  cb: (err: (Error & { stderr?: string }) | null, stdout: string, stderr: string) => void,
) => unknown;

interface RunnerOptions {
  platform?: string;
  execFile?: ExecFileFn;
  timeoutMs?: number;
}

const MAX_BUFFER = 5 * 1024 * 1024;

export function createOsascriptRunner(opts: RunnerOptions = {}): ScriptRunner {
  const platform = opts.platform ?? process.platform;
  const exec = opts.execFile ?? (nodeExecFile as unknown as ExecFileFn);
  const timeout = opts.timeoutMs ?? 60_000;
  if (platform !== "darwin") {
    return async () => {
      throw new AppleUnavailableError();
    };
  }
  return (script, payload) =>
    new Promise<string>((resolve, reject) => {
      exec("osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(payload)], { timeout, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.stderr || err.message).trim().slice(0, 300);
          reject(new Error(detail));
          return;
        }
        resolve(stdout);
      });
    });
}

/** `null` when Calendar can be scripted, otherwise a one-line message for the owner. */
export async function checkAppleAccess(run: ScriptRunner): Promise<string | null> {
  try {
    await run('function run() { return String(Application("Calendar").calendars().length); }', {});
    return null;
  } catch (err) {
    if (err instanceof AppleUnavailableError) return err.message;
    return "Apple Calendar and Reminders are not available. Allow this program under System Settings → Privacy & Security → Automation (Calendar, Reminders), then restart Fuse.";
  }
}
