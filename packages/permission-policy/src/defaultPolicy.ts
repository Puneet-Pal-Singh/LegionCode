import type { PermissionPolicy } from "./types.js";

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  defaultEffect: "ask",
  commands: {
    defaultEffect: "ask",
    rules: [
      readCommand("command.git-status", "git status*"),
      readCommand("command.git-diff", "git diff*"),
      readCommand("command.git-log", "git log*"),
      readCommand("command.git-show", "git show*"),
      askCommand("command.package-manager", "pnpm *"),
      denyCommand("command.remove", "rm *", "Destructive shell removal is denied."),
    ],
  },
  paths: {
    defaultEffect: "ask",
    rules: [
      denyPath("path.env-root", ".env*"),
      denyPath("path.env-nested", "**/.env*"),
      denyPath("path.git", ".git/**"),
      denyPath("path.node-modules", "node_modules/**"),
    ],
  },
  network: {
    defaultEffect: "ask",
    allowLocalNetwork: false,
    rules: [],
  },
  git: {
    defaultEffect: "ask",
    rules: [
      readGit("git.status", "status*"),
      readGit("git.diff", "diff*"),
      readGit("git.log", "log*"),
      readGit("git.show", "show*"),
      askGit("git.add", "add*"),
      askGit("git.commit", "commit*"),
      askGit("git.push", "push*"),
      denyGit("git.clean", "clean*", "Git clean can irreversibly remove files."),
      denyGit("git.reset", "reset*", "Git reset can discard local work."),
    ],
  },
  secrets: {
    defaultEffect: "deny",
    rules: [
      denySecret("secret.env", "env.*"),
      denySecret("secret.token", "*token*"),
      denySecret("secret.key", "*key*"),
    ],
  },
  tools: {
    defaultEffect: "ask",
    rules: [
      allowTool("tool.read", "read*"),
      allowTool("tool.list", "list*"),
      allowTool("tool.search", "search*"),
      askTool("tool.edit", "edit*"),
      askTool("tool.patch", "apply_patch*"),
      askTool("tool.command", "command*"),
      askTool("tool.git", "git*"),
      denyTool("tool.secret", "secret*"),
    ],
  },
};

function allowTool(id: string, pattern: string) {
  return { id, pattern, effect: "allow", riskLevel: "low" } as const;
}

function askTool(id: string, pattern: string) {
  return { id, pattern, effect: "ask", riskLevel: "medium" } as const;
}

function denyTool(id: string, pattern: string) {
  return { id, pattern, effect: "deny", riskLevel: "critical" } as const;
}

function readCommand(id: string, pattern: string) {
  return { id, pattern, effect: "allow", riskLevel: "low" } as const;
}

function askCommand(id: string, pattern: string) {
  return { id, pattern, effect: "ask", riskLevel: "medium" } as const;
}

function denyCommand(id: string, pattern: string, reason: string) {
  return { id, pattern, effect: "deny", reason, riskLevel: "critical" } as const;
}

function denyPath(id: string, pattern: string) {
  return { id, pattern, effect: "deny", riskLevel: "critical" } as const;
}

function readGit(id: string, pattern: string) {
  return { id, pattern, effect: "allow", riskLevel: "low" } as const;
}

function askGit(id: string, pattern: string) {
  return { id, pattern, effect: "ask", riskLevel: "high" } as const;
}

function denyGit(id: string, pattern: string, reason: string) {
  return { id, pattern, effect: "deny", reason, riskLevel: "critical" } as const;
}

function denySecret(id: string, pattern: string) {
  return { id, pattern, effect: "deny", riskLevel: "critical" } as const;
}
