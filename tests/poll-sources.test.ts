import { describe, expect, it, vi } from "vitest";
import { runPollSources } from "../src/poll-sources.js";

describe("runPollSources", () => {
  it("runs every source even when an earlier one fails, then rethrows the first error", async () => {
    const a = vi.fn(async () => {
      throw new Error("first failure");
    });
    const b = vi.fn(async () => 1);
    const c = vi.fn(async () => {
      throw new Error("second failure");
    });
    await expect(runPollSources([{ name: "a", run: a }, { name: "b", run: b }, { name: "c", run: c }])).rejects.toThrow("first failure");
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("resolves when nothing fails", async () => {
    await expect(runPollSources([{ name: "a", run: async () => 1 }])).resolves.toBeUndefined();
    await expect(runPollSources([])).resolves.toBeUndefined();
  });
});
