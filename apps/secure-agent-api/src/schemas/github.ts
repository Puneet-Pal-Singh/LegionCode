import type { ToolDefinition } from "../interfaces/types";

export const GitHubTools: ToolDefinition[] = [
  {
    name: "github_pr_list",
    description:
      "List pull requests for a repository. Head is an optional source-branch filter; use mergedLimit for the latest merged PRs across branches.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        state: {
          type: "string",
          description: "Pull request state (open, closed, all)",
        },
        head: {
          type: "string",
          description:
            "Head branch filter. For same-repo branches, pass only the branch name.",
        },
        mergedLimit: {
          type: "number",
          description:
            "Return the latest merged pull requests across all branches (1–20), with explicit pagination completeness.",
        },
        page: { type: "number", description: "Result page (default: 1)." },
        perPage: {
          type: "number",
          description: "Results per page (1–100, default: 100).",
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github_pr_files_get",
    description:
      "Read a paginated slice of changed PR files and bounded patch windows. Use nextFileOffset and each patchRange.endByte to continue; omitted patch status is reported explicitly.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        number: { type: "number", description: "Pull request number" },
        fileOffset: {
          type: "number",
          description: "Zero-based changed-file offset (default: 0).",
        },
        fileLimit: {
          type: "number",
          description: "Number of files to return, 1–100 (default: 20).",
        },
        fileName: {
          type: "string",
          description:
            "Optional exact path to retrieve one file's patch window.",
        },
        patchOffset: {
          type: "number",
          description:
            "UTF-8 byte offset within each returned patch (default: 0).",
        },
        patchLimit: {
          type: "number",
          description: "Patch window size in bytes, 1–4000 (default: 4000).",
        },
      },
      required: ["owner", "repo", "number"],
    },
  },
  {
    name: "github_pr_get",
    description: "Get remote metadata for a GitHub pull request.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        number: { type: "number", description: "Pull request number" },
      },
      required: ["owner", "repo", "number"],
    },
  },
  {
    name: "github_pr_checks_get",
    description: "Get check runs for a pull request head commit.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        number: { type: "number", description: "Pull request number" },
      },
      required: ["owner", "repo", "number"],
    },
  },
  {
    name: "github_review_threads_get",
    description: "Get review-thread-like pull request comment groupings.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        number: { type: "number", description: "Pull request number" },
      },
      required: ["owner", "repo", "number"],
    },
  },
  {
    name: "github_issue_get",
    description: "Get remote metadata for a GitHub issue.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        number: { type: "number", description: "Issue number" },
      },
      required: ["owner", "repo", "number"],
    },
  },
  {
    name: "github_actions_run_get",
    description: "Get metadata for a GitHub Actions workflow run.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        actionsRunId: { type: "number", description: "Workflow run id" },
      },
      required: ["owner", "repo", "actionsRunId"],
    },
  },
  {
    name: "github_actions_job_logs_get",
    description: "Get the latest log tail for a GitHub Actions workflow job.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        actionsJobId: { type: "number", description: "Workflow job id" },
        tailLines: {
          type: "number",
          description:
            "Optional max number of trailing log lines to return (default: 300).",
        },
      },
      required: ["owner", "repo", "actionsJobId"],
    },
  },
];
