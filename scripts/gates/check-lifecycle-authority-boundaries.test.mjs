import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { findLifecycleAuthorityViolations } from "./lifecycle-authority-rules.mjs";

describe("canonical lifecycle authority boundary", () => {
  it("rejects legacy lifecycle authorities and silent source fallbacks", () => {
    const projectRoot = resolve(import.meta.dirname, "../..");
    assert.deepEqual(findLifecycleAuthorityViolations(projectRoot), []);
  });
});
