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
    description: "Read a capped text window from a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        offset: {
          type: "number",
          description: "Zero-based line offset (default: 0)",
        },
        limit: {
          type: "number",
          description: "Maximum lines to return",
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
    description: "Write text content to a file. Overwrites if exists.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["path", "content"],
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
