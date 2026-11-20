import { join } from "node:path";

export interface PlistOptions {
  label: string;
  nodePath: string;
  projectDir: string;
  logDir: string;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** The launchd job that keeps Fuse running: starts at login, restarts after a crash. */
export function renderPlist(o: PlistOptions): string {
  const s = (value: string) => `<string>${escapeXml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${s(o.label)}
  <key>ProgramArguments</key>
  <array>
    ${s(o.nodePath)}
    ${s(`${o.projectDir}/dist/src/main.js`)}
  </array>
  <key>WorkingDirectory</key>
  ${s(o.projectDir)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  ${s(`${o.logDir}/fuse.out.log`)}
  <key>StandardErrorPath</key>
  ${s(`${o.logDir}/fuse.err.log`)}
</dict>
</plist>
`;
}

export interface AgentOptions extends PlistOptions {
  platform: string;
  home: string;
  uid: number;
  run: (cmd: string, args: string[]) => Promise<void>;
  write: (path: string, content: string) => void;
  mkdir: (path: string) => void;
  remove: (path: string) => void;
}

const requireMac = (platform: string): void => {
  if (platform !== "darwin") throw new Error("launchd is only available on macOS");
};

const plistPath = (o: AgentOptions): string => join(o.home, "Library", "LaunchAgents", `${o.label}.plist`).replace(/\\/g, "/");

/** Writes the plist and (re)loads it. Safe to run again after an update. Returns the plist path. */
export async function installAgent(o: AgentOptions): Promise<string> {
  requireMac(o.platform);
  const path = plistPath(o);
  o.mkdir(o.logDir);
  o.write(path, renderPlist(o));
  try {
    await o.run("launchctl", ["bootout", `gui/${o.uid}/${o.label}`]);
  } catch {
    // not loaded yet: nothing to unload
  }
  await o.run("launchctl", ["bootstrap", `gui/${o.uid}`, path]);
  await o.run("launchctl", ["enable", `gui/${o.uid}/${o.label}`]);
  return path;
}

export async function uninstallAgent(o: AgentOptions): Promise<void> {
  requireMac(o.platform);
  try {
    await o.run("launchctl", ["bootout", `gui/${o.uid}/${o.label}`]);
  } catch {
    // already unloaded
  }
  o.remove(plistPath(o));
}
