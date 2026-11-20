import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { AmbiguousActionError, runOnce } from "../src/idempotency.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("runOnce", () => {
  it("runs the action once per key and returns the stored result afterwards", async () => {
    let calls = 0;
    const action = async () => {
      calls++;
      return { id: 42 };
    };
    expect(await runOnce(db, "send:1", action)).toEqual({ id: 42 });
    expect(await runOnce(db, "send:1", action)).toEqual({ id: 42 });
    expect(calls).toBe(1);
  });

  it("runs different keys independently", async () => {
    let calls = 0;
    const action = async () => ++calls;
    await runOnce(db, "a", action);
    await runOnce(db, "b", action);
    expect(calls).toBe(2);
  });

  it("refuses to repeat an action that was started but never finished", async () => {
    db.prepare("INSERT INTO idempotency(key,status,created_at) VALUES ('crashed','started',1)").run();
    let called = false;
    await expect(
      runOnce(db, "crashed", async () => {
        called = true;
      }),
    ).rejects.toBeInstanceOf(AmbiguousActionError);
    expect(called).toBe(false);
  });

  it("clears the record when the action throws so a retry can run", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return "ok";
    };
    await expect(runOnce(db, "flaky", flaky)).rejects.toThrow("boom");
    expect(await runOnce(db, "flaky", flaky)).toBe("ok");
    expect(calls).toBe(2);
  });

  it("stores an undefined result without failing", async () => {
    expect(await runOnce(db, "void", async () => undefined)).toBeUndefined();
    expect(await runOnce(db, "void", async () => "never")).toBeUndefined();
  });
});
