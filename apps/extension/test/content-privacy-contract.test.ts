import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const signatureSource = readFileSync(
  new URL("../src/page-collaboration/content-signature.ts", import.meta.url),
  "utf8",
);

describe("content signature static privacy contract", () => {
  it.each([
    "textContent",
    "innerText",
    "innerHTML",
    "outerHTML",
    ".value",
    ".cookie",
    "localStorage",
    "sessionStorage",
    "getComputedStyle",
    "aria-label",
    ".id",
    "className",
    ".dataset",
  ])("does not access forbidden source %s", (forbiddenSource) => {
    expect(signatureSource).not.toContain(forbiddenSource);
  });

  it("contains no remote capture or raw-document API", () => {
    expect(signatureSource).not.toMatch(
      /canvas.*toDataURL|getDisplayMedia|getUserMedia|serializeToString|XMLSerializer/iu,
    );
  });
});
