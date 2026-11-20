import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localDateKey } from "../time.js";

const SNAPSHOT_LIMIT = 8000;
const DAY_MS = 24 * 60 * 60 * 1000;

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Keep the end of `text` (the newest lines) within `max` characters. */
function tail(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const firstBreak = cut.indexOf("\n");
  return firstBreak === -1 ? cut : cut.slice(firstBreak + 1);
}

export class MemoryStore {
  private readonly profilePath: string;
  private readonly longTermPath: string;
  private readonly dailyDir: string;

  constructor(
    dir: string,
    private readonly tz: string,
  ) {
    this.profilePath = join(dir, "profile.md");
    this.longTermPath = join(dir, "memory.md");
    this.dailyDir = join(dir, "daily");
    mkdirSync(this.dailyDir, { recursive: true });
    if (!existsSync(this.profilePath)) writeAtomic(this.profilePath, "");
    if (!existsSync(this.longTermPath)) writeAtomic(this.longTermPath, "");
  }

  readProfile(): string {
    return readOrEmpty(this.profilePath);
  }

  readLongTerm(): string {
    return readOrEmpty(this.longTermPath);
  }

  readDaily(dateKey: string): string {
    return readOrEmpty(join(this.dailyDir, `${dateKey}.md`));
  }

  /** Set one preference, replacing an existing entry for the same key (case-insensitive). */
  setProfileEntry(key: string, value: string): void {
    const cleanKey = key.replace(/\s+/g, " ").trim();
    const cleanValue = value.replace(/\s+/g, " ").trim();
    const entry = `- ${cleanKey}: ${cleanValue}`;
    const lines = this.readProfile().split("\n").filter((l) => l.length > 0);
    const wanted = cleanKey.toLowerCase();
    const index = lines.findIndex(
      (l) => l.startsWith("- ") && l.slice(2, l.indexOf(":")).trim().toLowerCase() === wanted,
    );
    if (index === -1) lines.push(entry);
    else lines[index] = entry;
    writeAtomic(this.profilePath, lines.join("\n") + "\n");
  }

  appendLongTerm(fact: string): void {
    this.appendLine(this.longTermPath, fact);
  }

  appendDaily(note: string, now: Date = new Date()): void {
    this.appendLine(join(this.dailyDir, `${localDateKey(now, this.tz)}.md`), note);
  }

  /** Profile + long-term memory + yesterday and today, capped near 8000 chars; the profile is never cut. */
  snapshotForPrompt(now: Date): string {
    const profile = this.readProfile().trim();
    const longTerm = this.readLongTerm().trim();
    const today = this.readDaily(localDateKey(now, this.tz)).trim();
    const yesterday = this.readDaily(localDateKey(new Date(now.getTime() - DAY_MS), this.tz)).trim();

    const profileBlock = `## Profile\n${profile}\n`;
    let room = Math.max(0, SNAPSHOT_LIMIT - profileBlock.length);

    // Newest information first: today, then yesterday, then long-term memory.
    const sections: { title: string; body: string }[] = [
      { title: "## Today", body: today },
      { title: "## Yesterday", body: yesterday },
      { title: "## Long-term memory", body: longTerm },
    ];
    const kept = new Map<string, string>();
    for (const s of sections) {
      if (!s.body) continue;
      const overhead = s.title.length + 3; // heading, newline, trailing newline, joining blank line
      const body = tail(s.body, room - overhead);
      if (!body) continue;
      kept.set(s.title, body);
      room -= overhead + body.length;
    }

    const ordered = ["## Long-term memory", "## Yesterday", "## Today"];
    const parts = [profileBlock];
    for (const title of ordered) {
      const body = kept.get(title);
      if (body) parts.push(`${title}\n${body}\n`);
    }
    return parts.join("\n");
  }

  private appendLine(path: string, text: string): void {
    const clean = text.replace(/\s+/g, " ").trim();
    const existing = readOrEmpty(path);
    const prefix = existing === "" || existing.endsWith("\n") ? existing : existing + "\n";
    writeAtomic(path, `${prefix}- ${clean}\n`);
  }
}
