import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Message } from "@ai-sdk/react";
import type { DiffContent, FileStatus } from "@repo/shared-types";
import { ChatMessage } from "./ChatMessage";

describe("ChatMessage", () => {
  it("renders assistant content as markdown", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      content: "**Final Report**\n\n- item one\n- item two",
    } as Message;

    const { container } = render(<ChatMessage message={message} />);

    expect(screen.getByText("Final Report").tagName).toBe("STRONG");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(screen.queryByText("**Final Report**")).not.toBeInTheDocument();
  });

  it("renders user content as markdown", () => {
    const message = {
      id: "user-1",
      role: "user",
      content: "Use `docs/` and [README](https://example.com)",
    } as Message;

    render(<ChatMessage message={message} />);

    expect(screen.getByText("docs/").tagName).toBe("CODE");
    const link = screen.getByRole("link", { name: "README" });
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  it("shows only the basename for user file mentions", () => {
    const message = {
      id: "user-mention",
      role: "user",
      content: "add logging to @src/components/dashboard/admin/pending-approvals/PendingJobCard.tsx",
    } as Message;

    render(<ChatMessage message={message} />);

    expect(screen.getByText(/@PendingJobCard\.tsx/)).toBeInTheDocument();
    expect(
      screen.queryByText(/@src\/components\/dashboard\/admin\/pending-approvals\/PendingJobCard\.tsx/),
    ).not.toBeInTheDocument();
  });

  it("does not rewrite code spans or markdown links when shortening mentions", () => {
    const message = {
      id: "user-markdown-mention",
      role: "user",
      content:
        'check `@src/components/dashboard/admin/pending-approvals/PendingJobCard.tsx` and [docs](https://example.com/@repo/shared-types) plus @"docs/API Guide.md"',
    } as Message;

    render(<ChatMessage message={message} />);

    expect(
      screen.getByText(
        "@src/components/dashboard/admin/pending-approvals/PendingJobCard.tsx",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute(
      "href",
      "https://example.com/@repo/shared-types",
    );
    expect(screen.getByText(/@API Guide\.md/)).toBeInTheDocument();
  });

  it("does not render markdown images", () => {
    const message = {
      id: "assistant-image",
      role: "assistant",
      content: "![remote](https://example.com/remote.png)",
    } as Message;

    const { container } = render(<ChatMessage message={message} />);

    expect(container.querySelector("img")).toBeNull();
  });

  it("shows assistant duration and completion time metadata", () => {
    const message = {
      id: "assistant-meta",
      role: "assistant",
      content: "Done.",
    } as Message;

    render(
      <ChatMessage
        message={message}
        metadata={{
          modeLabel: "Build",
          durationLabel: "195s",
          timeLabel: "12:42 AM",
        }}
      />,
    );

    expect(screen.getByText("Build · 12:42 AM")).toBeInTheDocument();
    expect(screen.queryByText("Build · 195s · 12:42 AM")).toBeNull();
  });

  it("shows only the prompt time for user message metadata", () => {
    const message = {
      id: "user-meta",
      role: "user",
      content: "ship it",
    } as Message;

    render(
      <ChatMessage
        message={message}
        metadata={{
          modeLabel: "Build",
          modelLabel: "Gemma 4 31B",
          timeLabel: "12:40 AM",
        }}
      />,
    );

    expect(screen.getByText("12:40 AM")).toBeInTheDocument();
    expect(screen.queryByText("Build · Gemma 4 31B · 12:40 AM")).toBeNull();
  });

  it("renders a changed files summary for assistant messages", () => {
    const message = {
      id: "assistant-changes",
      role: "assistant",
      content: "Done.",
    } as Message;
    const files: FileStatus[] = [
      {
        path: "apps/web/src/components/chat/ChatMessage.tsx",
        status: "modified",
        additions: 11,
        deletions: 2,
        isStaged: false,
      },
      {
        path: "packages/shared-types/src/git.ts",
        status: "modified",
        additions: 3,
        deletions: 0,
        isStaged: false,
      },
    ];

    render(<ChatMessage message={message} changedFilesSummary={{ files }} />);

    expect(screen.getByText("2 Changed files")).toBeInTheDocument();
    expect(screen.getByText("+14")).toBeInTheDocument();
    expect(screen.getAllByText("-2").length).toBeGreaterThan(0);
    expect(screen.getByText("ChatMessage.tsx")).toBeInTheDocument();
    expect(screen.getByText("git.ts")).toBeInTheDocument();
  });

  it("does not infer changed-file chips from assistant prose alone", () => {
    const message = {
      id: "assistant-filename-prose",
      role: "assistant",
      content:
        "I completed the requested update and changed this file:\n- src/components/landing/hero/index.tsx (+89 -27)",
    } as Message;

    render(<ChatMessage message={message} />);

    expect(screen.queryByRole("button", { name: /index\.tsx/i })).toBeNull();
    expect(screen.queryByText("Changed file")).toBeNull();
    expect(screen.queryByText("1 Changed file")).toBeNull();
  });

  it("strips inline change counts from assistant prose when grounded change summary is shown", () => {
    const message = {
      id: "assistant-grounded-change-prose",
      role: "assistant",
      content:
        "I completed the requested update and changed this file:\n- src/components/landing/hero/index.tsx (+89 -27)",
    } as Message;
    const files: FileStatus[] = [
      {
        path: "src/components/landing/hero/index.tsx",
        status: "modified",
        additions: 89,
        deletions: 27,
        isStaged: false,
      },
    ];

    render(<ChatMessage message={message} changedFilesSummary={{ files }} />);

    expect(
      screen.getByText(/src\/components\/landing\/hero\/index\.tsx/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\(\+89 -27\)/)).toBeNull();
  });

  it("uses loaded diff hunks for changed file stats", async () => {
    const message = {
      id: "assistant-changes-diff-stats",
      role: "assistant",
      content: "Done.",
    } as Message;
    const files: FileStatus[] = [
      {
        path: "src/index.tsx",
        status: "modified",
        additions: 0,
        deletions: 0,
        isStaged: false,
      },
    ];
    const loadFileDiff = vi.fn(async (): Promise<DiffContent> => {
      return {
        oldPath: "src/index.tsx",
        newPath: "src/index.tsx",
        isBinary: false,
        isNewFile: false,
        isDeleted: false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 3,
            header: "@@ -1,2 +1,3 @@",
            lines: [
              { type: "unchanged", content: " const value = 1", oldLineNumber: 1, newLineNumber: 1 },
              { type: "deleted", content: "-const oldValue = 2", oldLineNumber: 2 },
              { type: "added", content: "+const newValue = 2", newLineNumber: 2 },
              { type: "added", content: "+const anotherValue = 3", newLineNumber: 3 },
            ],
          },
        ],
      };
    });

    render(
      <ChatMessage
        message={message}
        changedFilesSummary={{ files, loadFileDiff }}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText("+2").length).toBeGreaterThan(0);
      expect(screen.getAllByText("-1").length).toBeGreaterThan(0);
    });
  });

  it("expands a changed file row inline", async () => {
    const message = {
      id: "assistant-changes-click",
      role: "assistant",
      content: "Done.",
    } as Message;
    const files: FileStatus[] = [
      {
        path: "src/index.tsx",
        status: "modified",
        additions: 1,
        deletions: 1,
        isStaged: false,
      },
    ];
    const loadFileDiff = vi.fn(async (): Promise<DiffContent> => {
      return {
        oldPath: "src/index.tsx",
        newPath: "src/index.tsx",
        isBinary: false,
        isNewFile: false,
        isDeleted: false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            header: "@@ -1 +1 @@",
            lines: [
              { type: "deleted", content: "-old", oldLineNumber: 1 },
              { type: "added", content: "+new", newLineNumber: 1 },
            ],
          },
        ],
      };
    });

    render(
      <ChatMessage
        message={message}
        changedFilesSummary={{ files, loadFileDiff }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /src\/index\.tsx/ }));

    await waitFor(() => {
      expect(screen.getByText("+new")).toBeInTheDocument();
      expect(screen.getByText("-old")).toBeInTheDocument();
    });
    expect(screen.queryByText("@@ -1 +1 @@")).toBeNull();
    expect(screen.queryByText(" const value = 1")).toBeNull();
  });

  it("does not repeat total line stats in the section header for a single changed file", () => {
    const message = {
      id: "assistant-single-change",
      role: "assistant",
      content: "Done.",
    } as Message;
    const files: FileStatus[] = [
      {
        path: "src/index.tsx",
        status: "modified",
        additions: 1,
        deletions: 1,
        isStaged: false,
      },
    ];

    render(<ChatMessage message={message} changedFilesSummary={{ files }} />);

    expect(screen.getByText("1 Changed file")).toBeInTheDocument();
    expect(screen.getAllByText("+1")).toHaveLength(1);
    expect(screen.getAllByText("-1")).toHaveLength(1);
  });
});
