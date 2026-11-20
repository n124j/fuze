import { describe, expect, it, vi } from "vitest";
import { installAgent, renderPlist, uninstallAgent } from "../src/ops/launchd.js";

const base = {
  label: "com.fuse.agent",
  nodePath: "/usr/local/bin/node",
  projectDir: "/Users/me/fuse",
  logDir: "/Users/me/fuse/data/logs",
};

describe("renderPlist", () => {
  it("contains the keys launchd needs", () => {
    const plist = renderPlist(base);
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>com.fuse.agent</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("<string>/Users/me/fuse</string>");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<string>/Users/me/fuse/data/logs/fuse.out.log</string>");
    expect(plist).toContain("<string>/Users/me/fuse/data/logs/fuse.err.log</string>");
  });

  it("runs node on the built main file, and nothing else", () => {
    const plist = renderPlist(base);
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)![1]!;
    expect([...args.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1])).toEqual(["/usr/local/bin/node", "/Users/me/fuse/dist/src/main.js"]);
  });

  it("escapes special characters in paths so the file stays valid", () => {
    const plist = renderPlist({ ...base, projectDir: "/Users/me/My & Co <fuse>" });
    expect(plist).toContain("My &amp; Co &lt;fuse&gt;");
    expect(plist).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(plist.startsWith("<?xml")).toBe(true);
    expect(plist).toContain("</plist>");
  });
});

function deps(over: Partial<Parameters<typeof installAgent>[0]> = {}) {
  const calls: string[] = [];
  const run = vi.fn(async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
  });
  const write = vi.fn();
  const mkdir = vi.fn();
  const remove = vi.fn();
  return {
    calls,
    run,
    write,
    mkdir,
    remove,
    o: { platform: "darwin", home: "/Users/me", uid: 501, ...base, run, write, mkdir, remove, ...over },
  };
}

describe("installAgent", () => {
  it("writes the plist, then reloads and enables it", async () => {
    const d = deps();
    const path = await installAgent(d.o);
    expect(path).toBe("/Users/me/Library/LaunchAgents/com.fuse.agent.plist");
    expect(d.write).toHaveBeenCalledWith(path, expect.stringContaining("com.fuse.agent"));
    expect(d.mkdir).toHaveBeenCalledWith("/Users/me/fuse/data/logs");
    expect(d.calls).toEqual([
      "launchctl bootout gui/501/com.fuse.agent",
      `launchctl bootstrap gui/501 ${path}`,
      "launchctl enable gui/501/com.fuse.agent",
    ]);
  });

  it("can be run twice, and carries on when the agent was not loaded yet", async () => {
    const d = deps();
    d.run.mockImplementationOnce(async () => {
      throw new Error("Boot-out failed: 5: Input/output error");
    });
    await installAgent(d.o);
    await installAgent(d.o);
    expect(d.calls.filter((c) => c.includes("bootstrap"))).toHaveLength(2);
    expect(d.calls.filter((c) => c.includes("bootout"))).toHaveLength(1); // the first, failing one was not recorded
  });

  it("refuses off macOS without touching anything", async () => {
    const d = deps({ platform: "win32" });
    await expect(installAgent(d.o)).rejects.toThrow("macOS");
    expect(d.run).not.toHaveBeenCalled();
    expect(d.write).not.toHaveBeenCalled();
  });
});

describe("uninstallAgent", () => {
  it("unloads the agent and removes the plist", async () => {
    const d = deps();
    await uninstallAgent(d.o);
    expect(d.calls).toEqual(["launchctl bootout gui/501/com.fuse.agent"]);
    expect(d.remove).toHaveBeenCalledWith("/Users/me/Library/LaunchAgents/com.fuse.agent.plist");
  });

  it("refuses off macOS", async () => {
    const d = deps({ platform: "linux" });
    await expect(uninstallAgent(d.o)).rejects.toThrow("macOS");
  });
});
