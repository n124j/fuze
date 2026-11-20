import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import { runOnce } from "../idempotency.js";
import type { GoogleHttp } from "./auth.js";

const TASKS = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";

export interface TaskItem {
  id: string;
  title: string;
  due?: Date;
  done: boolean;
}

interface GoogleTask {
  id: string;
  title?: string;
  status?: string;
  due?: string;
}

function toTask(g: GoogleTask): TaskItem {
  return {
    id: g.id,
    title: g.title ?? "(untitled)",
    due: g.due ? new Date(g.due) : undefined,
    done: g.status === "completed",
  };
}

export class TasksClient {
  constructor(
    private readonly http: Pick<GoogleHttp, "json">,
    private readonly db: Db,
  ) {}

  async listOpen(): Promise<TaskItem[]> {
    const res = await this.http.json<{ items?: GoogleTask[] }>("GET", TASKS, {
      query: { showCompleted: "false", maxResults: "100" },
    });
    return (res.items ?? []).map(toTask).filter((t) => !t.done);
  }

  /** Creates the task in the default list. The same title and due date are never created twice. */
  async create(title: string, due?: Date): Promise<TaskItem> {
    const key = `task:${createHash("sha256").update(`${title}|${due?.toISOString() ?? ""}`).digest("hex")}`;
    const raw = await runOnce(this.db, key, () =>
      this.http.json<GoogleTask>("POST", TASKS, { body: { title, ...(due ? { due: due.toISOString() } : {}) } }),
    );
    return toTask(raw);
  }
}
