import { describe, expect, it } from "vitest";
import {
  hasValidTaskInput,
  isConcreteCommandInput,
  isConcretePathInput,
} from "./TaskInputContract.js";

describe("TaskInputContract", () => {
  it("accepts concrete planner/executor inputs", () => {
    expect(hasValidTaskInput("analyze", { path: "src/main.ts" })).toBe(true);
    expect(hasValidTaskInput("shell", { command: "pnpm test" })).toBe(true);
    expect(hasValidTaskInput("git", { action: "git_status" })).toBe(true);
    expect(hasValidTaskInput("git", { action: "git_unstage" })).toBe(true);
    expect(hasValidTaskInput("review", undefined)).toBe(true);
  });

  it("rejects non-canonical git action aliases", () => {
    expect(hasValidTaskInput("git", { action: "status" })).toBe(false);
    expect(hasValidTaskInput("git", { action: "unstage" })).toBe(false);
    expect(hasValidTaskInput("git", { action: "git_config" })).toBe(false);
  });

  it("rejects vague descriptions as executable input", () => {
    expect(isConcretePathInput("Analyze the current workspace")).toBe(false);
    expect(isConcretePathInput("the repository")).toBe(false);
    expect(isConcretePathInput("my repo")).toBe(false);
    expect(isConcretePathInput("this")).toBe(false);
    expect(isConcreteCommandInput("check if node exists")).toBe(false);
    expect(hasValidTaskInput("analyze", { path: "read the file" })).toBe(false);
    expect(hasValidTaskInput("shell", { command: "if tests fail, fix them" })).toBe(false);
  });

  it("rejects punctuation-only or degenerate path candidates", () => {
    expect(isConcretePathInput("?")).toBe(false);
    expect(isConcretePathInput("...")).toBe(false);
    expect(isConcretePathInput("@")).toBe(false);
    expect(isConcretePathInput("\"README.md\"")).toBe(true);
    expect(isConcretePathInput("README.md?")).toBe(true);
  });

  it("allows concrete shell commands and 500-char boundary inputs", () => {
    expect(isConcreteCommandInput("find src -name '*.ts'")).toBe(true);
    expect(isConcretePathInput("a".repeat(500))).toBe(true);
    expect(isConcreteCommandInput("b".repeat(500))).toBe(true);
  });
});
