import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(file: string): string {
  return readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
}

describe("finalization architecture gate", () => {
  it("rejects tool-name and shell-command correctness inference", () => {
    const evidence = source("EvidenceLedger.ts");
    expect(evidence).not.toMatch(/case\s+["'](?:read_file|bash|git_diff|git_status)["']/);
    expect(evidence).not.toMatch(/git\\s\+|splitShellCommandSegments|stripEnvAssignments/);
  });

  it("keeps final presentation keyed by typed outcome code", () => {
    const finalizer = source("FinalAssistantMessageService.ts");
    expect(finalizer).toContain("TerminalOutcomeCode");
    expect(finalizer).not.toMatch(/normalize|sanitize|parseJson|JSON\.parse/);
  });

  it("has one visible final-part owner", () => {
    const finalizer = source("FinalAssistantMessageService.ts");
    expect(finalizer).toContain("only owner allowed to project a user-visible terminal part");
    expect(source("FinalMessageProjector.ts")).not.toContain("FinalSummaryBuilder");
  });
});
