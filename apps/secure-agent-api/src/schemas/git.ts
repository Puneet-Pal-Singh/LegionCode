import { ToolDefinition } from "../interfaces/types";

export const GitTools: ToolDefinition[] = [
  {
    name: "git_clone",
    description: "Clone a GitHub repository (public or private with token).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Repository HTTPS URL" },
        token: {
          type: "string",
          description: "Optional GitHub access token for private repos",
        },
        replaceExisting: {
          type: "boolean",
          description:
            "When true, replace an existing non-empty workspace directory before cloning (bootstrap recovery).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "git_diff",
    description:
      "View changes made to the codebase. Essential before committing.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "git_stage",
    description:
      "Stage files for commit. If no files specified, stages all changes.",
    parameters: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional array of file paths to stage",
        },
      },
      required: [],
    },
  },
  {
    name: "git_commit",
    description: "Commit staged changes with a descriptive message.",
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  {
    name: "git_push",
    description: "Push committed changes to remote repository.",
    parameters: {
      type: "object",
      properties: {
        remote: {
          type: "string",
          description: "Remote name (default: origin)",
        },
        branch: {
          type: "string",
          description: "Branch name (default: current)",
        },
      },
      required: [],
    },
  },
  {
    name: "git_pull",
    description: "Pull latest changes from remote repository.",
    parameters: {
      type: "object",
      properties: {
        remote: {
          type: "string",
          description: "Remote name (default: origin)",
        },
        branch: {
          type: "string",
          description: "Branch name (default: current)",
        },
      },
      required: [],
    },
  },
  {
    name: "git_fetch",
    description: "Fetch latest refs from remote without merging.",
    parameters: {
      type: "object",
      properties: {
        remote: {
          type: "string",
          description: "Remote name (default: origin)",
        },
      },
      required: [],
    },
  },
  {
    name: "git_branch_create",
    description: "Create and switch to a new branch.",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Name of the new branch" },
      },
      required: ["branch"],
    },
  },
  {
    name: "git_branch_switch",
    description: "Switch to an existing branch.",
    parameters: {
      type: "object",
      properties: {
        branch: {
          type: "string",
          description: "Name of the branch to switch to",
        },
      },
      required: ["branch"],
    },
  },
  {
    name: "git_branch_list",
    description: "List all local and remote branches.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "git_status",
    description:
      "Show current repository status including staged/unstaged changes.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "git_patch_capture",
    description: "Capture uncommitted workspace changes as a binary git patch.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "git_patch_apply",
    description: "Apply a saved binary git patch after workspace recovery.",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "Git patch payload" },
        dryRun: {
          type: "boolean",
          description: "When true, validate the patch without applying it",
        },
      },
      required: ["patch"],
    },
  },
  {
    name: "git_config",
    description: "Configure git authentication with token (internal use).",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "GitHub access token" },
      },
      required: ["token"],
    },
  },
];
