import { describe, expect, it } from "vitest";
import { formatRuntimeDiagnosticLogLine } from "./RuntimeDiagnosticLog.js";

describe("formatRuntimeDiagnosticLogLine", () => {
  it("formats runtime context as readable key-value fields", () => {
    const line = formatRuntimeDiagnosticLogLine("agentic-loop/tool", "failed", {
      runId: "run_abc",
      toolName: "read_file",
      elapsedMs: 1200,
      errorMessage: "Execution request timed out after 120000ms",
      metadata: { code: "TOOL_TIMEOUT" },
      ignored: undefined,
    });

    expect(line).toContain("[agentic-loop/tool/failed]");
    expect(line).toContain("runId=run_abc");
    expect(line).toContain("toolName=read_file");
    expect(line).toContain("elapsedMs=1200");
    expect(line).toContain(
      'errorMessage="Execution request timed out after 120000ms"',
    );
    expect(line).toContain('metadata="{\\"code\\":\\"TOOL_TIMEOUT\\"}"');
    expect(line).not.toContain("ignored=");
  });
});
