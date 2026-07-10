import { describe, expect, it } from "vitest";
import {
  extractExecutionFailure,
  formatExecutionResult,
  formatTaskOutput,
} from "./ResultFormatter.js";

describe("ResultFormatter", () => {
  it("extracts content text from nested execution payloads", () => {
    const result = {
      success: true,
      data: {
        content: "README contents",
      },
    };

    expect(formatExecutionResult(result)).toBe("README contents");
  });

  it("serializes unknown object payloads as JSON", () => {
    const result = {
      success: true,
      files: ["README.md"],
    };

    expect(formatExecutionResult(result)).toContain('"success": true');
    expect(formatExecutionResult(result)).toContain('"README.md"');
  });

  it("returns friendly fallback when task output is empty", () => {
    expect(formatTaskOutput(undefined)).toBe("no output");
  });

  it("extracts typed secure execution timeout failures", () => {
    const result = {
      status: "timeout",
      error: {
        code: "EXECUTION_TIMEOUT",
        message: "Execution request timed out after 120000ms",
      },
    };

    expect(extractExecutionFailure(result)).toBe(
      "TOOL_TIMEOUT: Execution request timed out after 120000ms",
    );
  });

  it("extracts typed secure execution failures", () => {
    const result = {
      status: "failure",
      error: {
        code: "ENOENT",
        message: "File not found: README.md",
      },
    };

    expect(extractExecutionFailure(result)).toBe(
      "TOOL_FAILED: File not found: README.md",
    );
  });

  it("extracts structured errors from legacy success false results", () => {
    const result = {
      success: false,
      error: {
        code: "PLUGIN_EXECUTION_FAILED",
        message: "Git commit author is not configured.",
      },
    };

    expect(extractExecutionFailure(result)).toBe(
      "Git commit author is not configured.",
    );
  });

  it("redacts internal sandbox run paths from task output", () => {
    const result = {
      message:
        "cat: /home/sandbox/runs/4ccbe9ee-6201-4d9b-8377-dbae1e386894/README.md: No such file or directory",
    };

    const formatted = formatExecutionResult(result);
    expect(formatted).not.toContain(
      "/home/sandbox/runs/4ccbe9ee-6201-4d9b-8377-dbae1e386894/",
    );
    expect(formatted).toContain(
      "The requested file was not found in the current workspace.",
    );
  });
});
