import { describe, expect, it } from "vitest";
import { sanitizeUserFacingOutput } from "./RunOutputSanitizer.js";

describe("RunOutputSanitizer", () => {
  it("strips leaked internal planning prefaces while preserving user-facing text", () => {
    const output = sanitizeUserFacingOutput(
      "I need to check PR #58 status first. CI checks are green and ready for merge.",
    );

    expect(output).toBe("CI checks are green and ready for merge.");
  });

  it("keeps legitimate user-facing responses that start with 'I need to' but are not planning chatter", () => {
    const output = sanitizeUserFacingOutput(
      "I need to confirm one detail before I proceed: which branch should I target?",
    );

    expect(output).toBe(
      "I need to confirm one detail before I proceed: which branch should I target?",
    );
  });

  it("strips leaked greeting analysis before the user-facing answer", () => {
    const output = sanitizeUserFacingOutput(
      'The user is greeting me with "how are you?". This is a casual greeting. I should respond politely. I am doing great, thank you for asking!',
    );

    expect(output).toBe("I am doing great, thank you for asking!");
  });

  it("strips malformed leaked greeting analysis with orphan punctuation", () => {
    const output = sanitizeUserFacingOutput(
      ". This is a greeting. I should respond politely and ask how I can help them with their project Puneet-Pal-Singh/career-crew.Hello! How can I help you with the career-crew project today?",
    );

    expect(output).toBe(
      "Hello! How can I help you with the career-crew project today?",
    );
  });
});
