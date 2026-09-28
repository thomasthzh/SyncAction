import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/passwords.js";

describe("password hashing", () => {
  it("stores no plaintext and verifies only the matching password", async () => {
    const hash = await hashPassword("correct horse battery");

    expect(hash).toMatch(/^\$argon2id\$/u);
    expect(hash).not.toContain("correct horse battery");
    await expect(verifyPassword(hash, "correct horse battery")).resolves.toBe(true);
    await expect(verifyPassword(hash, "wrong horse battery")).resolves.toBe(false);
  });
});
