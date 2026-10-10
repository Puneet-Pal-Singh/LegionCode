import { describe, expect, it } from "vitest";
import {
  applyFileMention,
  filterFileMentionCandidates,
  findActiveFileMention,
  getPreferredMentionPath,
  listFileMentions,
} from "./fileMentions.js";

describe("fileMentions", () => {
  it("finds an active file mention at the caret", () => {
    expect(findActiveFileMention("check @src/compo", 16)).toEqual({
      start: 6,
      end: 16,
      query: "src/compo",
    });
  });

  it("ignores @ characters inside other words", () => {
    expect(findActiveFileMention("email@test.com", 14)).toBeNull();
  });

  it("replaces the active mention with a file path", () => {
    expect(
      applyFileMention(
        "inspect @rea please",
        { start: 8, end: 12, query: "rea" },
        "README.md",
      ),
    ).toEqual({
      nextValue: "inspect @README.md  please",
      nextCaret: 19,
    });
  });

  it("quotes mention paths that contain spaces", () => {
    expect(
      applyFileMention(
        "inspect @api please",
        { start: 8, end: 12, query: "api" },
        "docs/API Guide.md",
      ),
    ).toEqual({
      nextValue: 'inspect @"docs/API Guide.md"  please',
      nextCaret: 29,
    });
  });

  it("replaces the full token when the caret is inside a mention", () => {
    expect(
      applyFileMention(
        'inspect @"docs/API Guide.md" please',
        { start: 8, end: 29, query: "docs/API" },
        "README.md",
      ),
    ).toEqual({
      nextValue: "inspect @README.md please",
      nextCaret: 19,
    });
  });

  it("ignores scoped @ segments inside quoted mentions", () => {
    expect(
      findActiveFileMention('check @"packages/@scope/pkg.ts"', 27),
    ).toEqual({
      start: 6,
      end: 31,
      query: "packages/@scope/pkg",
    });
  });

  it("ranks closer file matches ahead of broader path matches", () => {
    expect(
      filterFileMentionCandidates(
        [
          "apps/web/src/components/chat/ChatInputBar.tsx",
          "README.md",
          "apps/web/src/components/chat/ChatMessage.tsx",
        ],
        "chati",
      ),
    ).toEqual(["apps/web/src/components/chat/ChatInputBar.tsx"]);
  });

  it("prefers the basename when it is unique in the repo tree", () => {
    expect(
      getPreferredMentionPath("src/components/chat/ChatInputBar.tsx", [
        "README.md",
        "src/components/chat/ChatInputBar.tsx",
      ]),
    ).toBe("ChatInputBar.tsx");
  });

  it("keeps the full path when the basename is duplicated", () => {
    expect(
      getPreferredMentionPath("src/components/chat/index.ts", [
        "src/components/chat/index.ts",
        "src/lib/index.ts",
      ]),
    ).toBe("src/components/chat/index.ts");
  });

  it("lists file mention tokens with basename metadata", () => {
    expect(
      listFileMentions(
        'check @src/components/chat/ChatInputBar.tsx and @"docs/API Guide.md"',
      ),
    ).toEqual([
      {
        start: 6,
        end: 43,
        path: "src/components/chat/ChatInputBar.tsx",
        displayName: "ChatInputBar.tsx",
        directory: "src/components/chat",
      },
      {
        start: 48,
        end: 68,
        path: "docs/API Guide.md",
        displayName: "API Guide.md",
        directory: "docs",
      },
    ]);
  });
});
