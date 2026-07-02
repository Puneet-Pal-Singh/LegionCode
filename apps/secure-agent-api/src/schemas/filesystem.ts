import { ToolDefinition } from "../interfaces/types";

export const FileSystemTools: ToolDefinition[] = [
  {
    name: "list_files",
    description:
      "List files and directories in the current path. Use this to explore the environment.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default: .)" },
      },
    },
  },
  {
    name: "read_file",
    description:
      "Read a capped, line-numbered text window from a file. Use offset/limit to continue from the nextOffset reported in truncated results.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        offset: {
          type: "number",
          description:
            "Zero-based line offset. Use the previous read_file result's nextOffset to continue.",
        },
        limit: {
          type: "number",
          description:
            "Maximum lines to return. Defaults to 200 and is capped at 1000.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "files",
    description: "List workspace files quickly with ripgrep, excluding .git.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default: .)" },
        glob: { type: "string", description: "Optional glob include filter" },
        maxResults: { type: "number", description: "Maximum paths to return" },
      },
    },
  },
  {
    name: "tree",
    description: "Return a capped workspace tree built from ripgrep file rows.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default: .)" },
        glob: { type: "string", description: "Optional glob include filter" },
        maxResults: { type: "number", description: "Maximum rows to return" },
      },
    },
  },
  {
    name: "glob",
    description: "Find workspace files by glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern" },
        path: { type: "string", description: "Directory path (default: .)" },
        maxResults: { type: "number", description: "Maximum paths to return" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search workspace file content by regular expression.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Ripgrep regular expression" },
        path: { type: "string", description: "Directory path (default: .)" },
        glob: { type: "string", description: "Optional glob include filter" },
        maxResults: { type: "number", description: "Maximum rows to return" },
        caseSensitive: { type: "boolean", description: "Match case exactly" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "write_file",
    description: "Atomically write text content to a workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        content: { type: "string", description: "The content to write" },
        expectedSha256: {
          type: "string",
          description: "Optional SHA-256 precondition for an existing file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Atomically replace exact text in one workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        oldText: { type: "string", description: "Exact text to replace" },
        newText: { type: "string", description: "Replacement text" },
        replaceAll: { type: "boolean", description: "Replace every match" },
        expectedReplacements: {
          type: "number",
          description: "Required exact match count",
        },
        expectedSha256: {
          type: "string",
          description: "Optional SHA-256 precondition",
        },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    name: "multi_edit",
    description: "Apply validated exact-text edits across multiple files.",
    parameters: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          description: "One exact-text edit per unique file",
        },
      },
      required: ["edits"],
    },
  },
  {
    name: "format_file",
    description: "Format one supported workspace file with Prettier.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "language_diagnostics",
    description: "Run bounded TypeScript diagnostics for the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "TypeScript or JavaScript file establishing intent",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "make_dir",
    description: "Create a new directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to create" },
      },
      required: ["path"],
    },
  },
];
