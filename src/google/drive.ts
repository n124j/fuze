import type { GoogleHttp } from "./auth.js";

const FILES = "https://www.googleapis.com/drive/v3/files";
const DEFAULT_MAX_CHARS = 8000;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modified: Date;
}

const escapeQuery = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** Read-only access to Drive: search by content and read text-like files. */
export class DriveClient {
  constructor(private readonly http: Pick<GoogleHttp, "json" | "text">) {}

  async search(query: string, limit = 10): Promise<DriveFile[]> {
    const res = await this.http.json<{ files?: { id: string; name: string; mimeType: string; modifiedTime: string }[] }>(
      "GET",
      FILES,
      {
        query: {
          q: `fullText contains '${escapeQuery(query)}' and trashed = false`,
          pageSize: String(limit),
          fields: "files(id,name,mimeType,modifiedTime)",
          orderBy: "modifiedTime desc",
        },
      },
    );
    return (res.files ?? []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modified: new Date(f.modifiedTime) }));
  }

  async readText(fileId: string, maxChars = DEFAULT_MAX_CHARS): Promise<string> {
    const meta = await this.http.json<{ mimeType: string }>("GET", `${FILES}/${encodeURIComponent(fileId)}`, {
      query: { fields: "mimeType" },
    });
    const id = encodeURIComponent(fileId);
    let content: string;
    if (meta.mimeType === "application/vnd.google-apps.spreadsheet") {
      content = await this.http.text(`${FILES}/${id}/export`, { mimeType: "text/csv" });
    } else if (meta.mimeType.startsWith("application/vnd.google-apps.")) {
      content = await this.http.text(`${FILES}/${id}/export`, { mimeType: "text/plain" });
    } else if (meta.mimeType.startsWith("text/")) {
      content = await this.http.text(`${FILES}/${id}`, { alt: "media" });
    } else {
      return `I cannot read this file type (${meta.mimeType}).`;
    }
    return content.slice(0, maxChars);
  }
}
