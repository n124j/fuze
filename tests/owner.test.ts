import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { OwnerRegistry } from "../src/gateway/owner.js";

const FIFTEEN_MIN = 15 * 60 * 1000;
let t: number;
let owners: OwnerRegistry;
beforeEach(() => {
  t = 1_000_000;
  owners = new OwnerRegistry(openDb(":memory:"), () => t);
});

describe("OwnerRegistry pairing", () => {
  it("pairs with a fresh code exactly once", () => {
    const code = owners.createPairingCode();
    expect(owners.pair("telegram", "42", "42", code)).toBe(true);
    expect(owners.isOwner("telegram", "42")).toBe(true);
    expect(owners.pair("telegram", "99", "99", code)).toBe(false);
    expect(owners.isOwner("telegram", "99")).toBe(false);
  });

  it("rejects a wrong code", () => {
    owners.createPairingCode();
    expect(owners.pair("telegram", "42", "42", "not-the-code")).toBe(false);
    expect(owners.isOwner("telegram", "42")).toBe(false);
  });

  it("ignores case and surrounding spaces in the code", () => {
    const code = owners.createPairingCode();
    expect(owners.pair("telegram", "42", "42", `  ${code.toUpperCase()} `)).toBe(true);
  });

  it("expires a code after 15 minutes", () => {
    const code = owners.createPairingCode();
    t += FIFTEEN_MIN + 1;
    expect(owners.pair("telegram", "42", "42", code)).toBe(false);
  });

  it("still accepts a code just inside the window", () => {
    const code = owners.createPairingCode();
    t += FIFTEEN_MIN - 1;
    expect(owners.pair("telegram", "42", "42", code)).toBe(true);
  });

  it("makes codes hard to guess and different each time", () => {
    const a = owners.createPairingCode();
    const b = owners.createPairingCode();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(10);
  });

  it("remembers the owner's chat for later messages", () => {
    expect(owners.ownerChat("telegram")).toBeNull();
    owners.pair("telegram", "42", "4242", owners.createPairingCode());
    expect(owners.ownerChat("telegram")).toBe("4242");
  });

  it("keeps channels separate", () => {
    owners.pair("telegram", "42", "42", owners.createPairingCode());
    expect(owners.isOwner("whatsapp", "42")).toBe(false);
  });

  it("replaces the previous owner when someone pairs again", () => {
    owners.pair("telegram", "42", "42", owners.createPairingCode());
    owners.pair("telegram", "77", "77", owners.createPairingCode());
    expect(owners.isOwner("telegram", "42")).toBe(false);
    expect(owners.isOwner("telegram", "77")).toBe(true);
  });

  it("reports whether any owner is paired", () => {
    expect(owners.hasOwner("telegram")).toBe(false);
    owners.setOwner("telegram", "42", "42");
    expect(owners.hasOwner("telegram")).toBe(true);
  });
});
