import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db.js";
import type { TaskItem } from "../google/tasks.js";
import { runOnce } from "../idempotency.js";
import type { ScriptRunner } from "./osascript.js";

const LIST_SCRIPT = `
function run(argv) {
  var app = Application("Reminders");
  var out = [];
  var lists = app.lists();
  for (var i = 0; i < lists.length; i++) {
    var rs = lists[i].reminders.whose({completed: false})();
    for (var j = 0; j < rs.length; j++) {
      var r = rs[j];
      var d = r.dueDate();
      out.push({id: String(r.id()), title: r.name() || "", due: d ? d.toISOString() : null, list: lists[i].name()});
    }
  }
  return JSON.stringify(out);
}`;

const CREATE_SCRIPT = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var app = Application("Reminders");
  var props = {name: p.title};
  if (p.due) props.dueDate = new Date(p.due);
  var r = app.Reminder(props);
  app.defaultList().reminders.push(r);
  return JSON.stringify({id: String(r.id())});
}`;

const listed = z.array(z.object({ id: z.string().min(1), title: z.string(), due: z.iso.datetime().nullable() }));
const created = z.object({ id: z.string().min(1) });

export class RemindersClient {
  constructor(
    private readonly run: ScriptRunner,
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async listOpen(): Promise<TaskItem[]> {
    const rows = listed.parse(JSON.parse(await this.run(LIST_SCRIPT, {})));
    return rows.map((r) => ({ id: `apple:${r.id}`, title: r.title.trim() || "(untitled)", due: r.due ? new Date(r.due) : undefined, done: false }));
  }

  /** Creates the reminder in the default list. The same title and due date are not created twice within an hour. */
  async create(title: string, due?: Date): Promise<TaskItem> {
    const hour = Math.floor(this.now() / 3_600_000);
    const key = `reminder:${createHash("sha256").update(`${hour}|${title}|${due?.toISOString() ?? ""}`).digest("hex")}`;
    const made = await runOnce(this.db, key, async () =>
      created.parse(JSON.parse(await this.run(CREATE_SCRIPT, { title, due: due?.toISOString() ?? null }))),
    );
    return { id: `apple:${made.id}`, title, due, done: false };
  }
}
