import React from 'react';
import { 
  Terminal, 
  Settings, 
  GitBranch, 
  Cpu, 
  Key, 
  HelpCircle, 
  ShieldAlert, 
  FolderGit2, 
  Play, 
  Layers, 
  Activity, 
  CheckCircle2, 
  AlertCircle,
  FileCode,
  Sparkles,
  Blocks,
  RefreshCw,
  Sliders,
  ChevronRight,
  BookOpen
} from 'lucide-react';

export interface DocPage {
  slug: string;
  title: string;
  description: string;
  category: string;
  status?: 'alpha' | 'beta' | 'planned' | 'draft';
  toc: { id: string; text: string }[];
  elements: Array<
    | { type: 'paragraph'; text: string }
    | { type: 'heading'; level: 2 | 3; id: string; text: string }
    | { type: 'code'; code: string; language?: string }
    | { type: 'callout'; variant: 'info' | 'warning' | 'tip' | 'todo'; text: string; title?: string }
    | { type: 'table'; headers: string[]; rows: string[][] }
    | { type: 'list'; items: string[] }
    | { type: 'features'; items: { title: string; desc: string; icon?: React.ReactNode }[] }
  >;
}

export interface SidebarCategory {
  id: string;
  title: string;
  icon: React.ReactNode;
  pages: { title: string; slug: string; status?: string }[];
}

export const sidebarStructure: SidebarCategory[] = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    icon: <BookOpen className="w-4 h-4" />,
    pages: [
      { title: 'Introduction', slug: 'introduction' },
      { title: 'Quickstart', slug: 'quickstart' },
      { title: 'Public Alpha', slug: 'public-alpha', status: 'Alpha' },
      { title: 'Concepts', slug: 'concepts' },
    ]
  },
  {
    id: 'using-legioncode',
    title: 'Using LegionCode',
    icon: <FolderGit2 className="w-4 h-4" />,
    pages: [
      { title: 'Web App', slug: 'web-app' },
      { title: 'Repositories', slug: 'repositories' },
      { title: 'Agents', slug: 'agents' },
      { title: 'Runs', slug: 'runs' },
      { title: 'Reviewing Diffs', slug: 'reviewing-diffs' },
      { title: 'Parallel Tasks', slug: 'parallel-tasks' },
    ]
  },
  {
    id: 'execution',
    title: 'Execution',
    icon: <Cpu className="w-4 h-4" />,
    pages: [
      { title: 'Execution Harness', slug: 'execution-harness' },
      { title: 'Cloud Sandboxes', slug: 'cloud-sandboxes' },
      { title: 'Sessions', slug: 'sessions' },
      { title: 'Debugging', slug: 'debugging' },
      { title: 'Validation Gates', slug: 'validation-gates' },
    ]
  },
  {
    id: 'configuration',
    title: 'Configuration',
    icon: <Sliders className="w-4 h-4" />,
    pages: [
      { title: 'Model Providers', slug: 'model-providers' },
      { title: 'Provider Keys', slug: 'provider-keys' },
      { title: 'Permissions', slug: 'permissions' },
      { title: 'Environment Variables', slug: 'environment-variables' },
      { title: 'Rules', slug: 'rules' },
    ]
  },
  {
    id: 'self-hosting',
    title: 'Self-hosting',
    icon: <Settings className="w-4 h-4" />,
    pages: [
      { title: 'Local Development', slug: 'local-development' },
      { title: 'Cloudflare Setup', slug: 'cloudflare-setup' },
      { title: 'Deployment', slug: 'deployment' },
      { title: 'Troubleshooting', slug: 'troubleshooting' },
    ]
  },
  {
    id: 'reference',
    title: 'Reference',
    icon: <Terminal className="w-4 h-4" />,
    pages: [
      { title: 'Repo Structure', slug: 'repo-structure' },
      { title: 'Package Scripts', slug: 'package-scripts' },
      { title: 'API Reference', slug: 'api-reference' },
      { title: 'Changelog', slug: 'changelog' },
    ]
  }
];

export const docsPages: Record<string, DocPage> = {
  // GETTING STARTED SECTION //
  'introduction': {
    slug: 'introduction',
    title: 'Introduction',
    description: 'An open-source, web-native coding-agent workspace built on a Cloudflare-native execution harness.',
    category: 'Getting Started',
    toc: [
      { id: 'why-legioncode', text: 'Why LegionCode exists' },
      { id: 'core-principles', text: 'Core principles' },
      { id: 'how-runs-work', text: 'How runs work' },
    ],
    elements: [
      { type: 'paragraph', text: 'An open-source, web-native coding-agent workspace built on a Cloudflare-native execution harness.' },
      { type: 'paragraph', text: 'LegionCode connects to your repository, runs coding agents in isolated cloud workspaces, and lets you review every file change before it reaches your main branch.' },
      { type: 'paragraph', text: 'It is designed for developers who want the convenience of cloud-hosted coding agents without giving up provider choice, execution visibility, or review control.' },
      { type: 'heading', level: 2, id: 'why-legioncode', text: 'Why LegionCode exists' },
      { type: 'paragraph', text: 'Most coding agents are either local terminal tools or closed cloud products. LegionCode takes a different path: a web-native workspace where agents run in isolated sessions, changes are tracked as diffs, and model providers stay configurable.' },
      { type: 'paragraph', text: 'LegionCode focuses on three core principles:' },
      {
        type: 'features',
        items: [
          {
            title: 'Provider Freedom',
            desc: 'Bring your own model provider keys and route agents through OpenAI, Anthropic, Google, Groq, OpenRouter, Together, Cerebras, OpenCode Go, and OpenCode Zen.',
            icon: <Key className="text-secondary w-5 h-5" />
          },
          {
            title: 'Isolated Execution',
            desc: 'Run agent tasks inside isolated cloud workspaces instead of directly on your local machine.',
            icon: <Cpu className="text-secondary w-5 h-5" />
          },
          {
            title: 'Review-First Workflow',
            desc: 'Inspect changed files, review split diffs, and approve work before it reaches your main branch.',
            icon: <GitBranch className="text-secondary w-5 h-5" />
          },
        ]
      },
      { type: 'heading', level: 2, id: 'core-principles', text: 'Core principles' },
      { type: 'list', items: [
        'Developer-First Control: No changes are ever applied directly to your upstream branch without manual diff verification.',
        'Zero Heavy Runtimes: Orchestrated entirely via serverless Cloudflare Workers and isolated APIs to make setup instantaneous and cheap.',
        'Transparency Over Magic: Ditch the logs "magic"; inspect exactly what terminal command the model triggered, what files it read, and its detailed prompt trace.'
      ]},
      { type: 'heading', level: 2, id: 'how-runs-work', text: 'How runs work' },
      { type: 'paragraph', text: 'The LegionCode repository is styled as a PNPM monorepo, separating worries perfectly between the workspace UI frontend, state manager APIs, isolated sandboxing interfaces, and deep repository parsing utilities.' },
      { type: 'callout', variant: 'info', text: 'LegionCode is currently in Public Alpha. The codebase is under constant revision. Review our concepts guide and repo reference to understand how the internal apps coordinate.', title: 'Alpha Phase Notice' }
    ]
  },

  'quickstart': {
    slug: 'quickstart',
    title: 'Quickstart',
    description: 'Jumpstart your local LegionCode environment in under 5 minutes.',
    category: 'Getting Started',
    toc: [
      { id: 'prerequisites', text: 'Prerequisites' },
      { id: 'installation', text: 'Installation Step' },
      { id: 'running-local-dev', text: 'Running the Workspace' },
      { id: 'running-components', text: 'Service Filters' },
      { id: 'ports-and-verification', text: 'Ports & Verification' },
    ],
    elements: [
      { type: 'paragraph', text: 'Setup your LegionCode monorepo locally to inspect, run, and modify the system. This guide walks you through the step-by-step installation, core script execution, and service ports verifying.' },
      { type: 'heading', level: 2, id: 'prerequisites', text: 'Prerequisites' },
      { type: 'paragraph', text: 'Before executing scripts, please verify your matching local requirements:' },
      { type: 'list', items: [
        'Node.js Version 20 or higher',
        'PNPM Package Manager Version 8 or 9 (highly recommended)',
        'Cloudflare Wrangler CLI (installed globally or accessible via npx wrangler)',
        'A local Git client'
      ]},
      { type: 'heading', level: 2, id: 'installation', text: 'Installation Step' },
      { type: 'paragraph', text: 'Clone the repository and run dependencies bootstrapping in the workspace root folder:' },
      { type: 'code', code: `git clone https://github.com/Puneet-Pal-Singh/LegionCode.git\ncd LegionCode\npnpm install`, language: 'bash' },
      { type: 'heading', level: 2, id: 'running-local-dev', text: 'Running the Workspace' },
      { type: 'paragraph', text: 'To launch the entire suite concurrently (including frontend UI and worker APIs), run:' },
      { type: 'code', code: 'pnpm dev', language: 'bash' },
      { type: 'heading', level: 2, id: 'running-components', text: 'Service Filters' },
      { type: 'paragraph', text: 'If you want to debug or launch individual apps and packages separately instead of the whole cluster, use the command filters below:' },
      { type: 'code', code: `# Launch React Frontend Only\npnpm --filter @shadowbox/web dev\n\n# Launch AI Orchestrator Boundary Worker Only\npnpm --filter @shadowbox/brain dev\n\n# Launch Session execution API Worker Only\npnpm --filter @shadowbox/secure-agent-api dev`, language: 'bash' },
      { type: 'heading', level: 2, id: 'ports-and-verification', text: 'Ports & Verification' },
      { type: 'paragraph', text: 'By default, the services bind to these local interfaces:' },
      {
        type: 'table',
        headers: ['Service Identifier', 'Port Bind', 'Access Boundary'],
        rows: [
          ['@shadowbox/web', '3000', 'browser localhost:3000'],
          ['@shadowbox/brain', '8787', 'worker boundary api'],
          ['@shadowbox/secure-agent-api', '8788', 'sandbox sessions harness']
        ]
      },
      { type: 'paragraph', text: 'Run these curl commands in your terminal to verify that your services are compiling and responsive:' },
      { type: 'code', code: `# Test Brain worker output\ncurl http://localhost:8787/api/debug/runtime\n\n# Test Secure API worker output\ncurl http://localhost:8788/api/debug/runtime`, language: 'bash' },
    ]
  },

  'public-alpha': {
    slug: 'public-alpha',
    title: 'Public Alpha',
    description: 'Current development phase overview, limitations, and support plans.',
    category: 'Getting Started',
    toc: [
      { id: 'alpha-boundaries', text: 'Current System Status' },
      { id: 'planned-updates', text: 'Planned Capabilities' },
    ],
    elements: [
      { type: 'paragraph', text: 'LegionCode is currently in active Public Alpha (v0.0.1). The platform is available for early engineering testing, architectural review, and decentralized local contributions.' },
      { type: 'heading', level: 2, id: 'alpha-boundaries', text: 'Current System Status' },
      { type: 'paragraph', text: 'As an alpha participant, you should expect certain structural limitations:' },
      { type: 'list', items: [
        'Breaking changes: API request parameters and cross-package schema models in shared-types will change without warning.',
        'Database persistence constraints: Workspaces are mostly transient. Database sync cycles require periodic manual schema updates on your wrangler endpoints.',
        'Security sandbox refinement: While isolated, sandboxing is locked to standard wrangler mock configurations locally, and requires precise deployment to restrict outbound socket requests securely.'
      ]},
      { type: 'heading', level: 2, id: 'planned-updates', text: 'Planned Capabilities' },
      { type: 'paragraph', text: 'Future milestones include deep native Cloudflare Durable Objects clustering for zero-latency agent sessions, R2 sandbox mount attachments, and multi-file real-time visual streams.' },
      { type: 'callout', variant: 'warning', text: 'Do not deploy LegionCode in critical enterprise networks without implementing private VPC restrictions on your execution workers.', title: 'Security Best Practice' }
    ]
  },

  'concepts': {
    slug: 'concepts',
    title: 'Concepts',
    description: 'A structural glossary of terms, mechanisms, and models running within LegionCode.',
    category: 'Getting Started',
    toc: [
      { id: 'monorepo-terminology', text: 'Core Terms' },
      { id: 'byok-paradigm', text: 'Bring Your Own Key (BYOK)' },
    ],
    elements: [
      { type: 'paragraph', text: 'Before jumping deep into the pages, familiarize yourself with how the LegionCode platform names and models the workspace behaviors.' },
      { type: 'heading', level: 2, id: 'monorepo-terminology', text: 'Core Terms' },
      {
        type: 'features',
        items: [
          { title: 'Workspaces', desc: 'An isolated contextual map linking a repository, its specific rules, model configurations, and all active agent runs.' },
          { title: 'Agents', desc: 'Specialized LLM-powered background workers that use tools (file reading, search, bash scripts) to complete concrete developer tasks.' },
          { title: 'Runs & Tasks', desc: 'A Task is a request assigned to an agent. A Run represents the unique execution state, containing agent prompts, tool calls, and output logs.' },
          { title: 'Sandbox Sessions', desc: 'Temporary sandboxed environments running under apps/secure-agent-api, isolating commands and file writes.' },
          { title: 'Diffs', desc: 'The physical file changes generated by an agent run. Represented on the dashboard as visual side-by-side split reviewers.' }
        ]
      },
      { type: 'heading', level: 2, id: 'byok-paradigm', text: 'Bring Your Own Key (BYOK)' },
      { type: 'paragraph', text: 'LegionCode advocates for zero LLM markup. You configure custom API keys for OpenRouter, Anthropic, or OpenAI directly. The key is either stored securely on your browser client or injected on execution requests, keeping your operational costs aligned purely with raw provider rates.' },
      { type: 'callout', variant: 'tip', text: 'The cross-app contracts that bind all these entities are declared under packages/shared-types, preventing schema divergence.', title: 'Design Tip' }
    ]
  },

  // USING LEGIONCODE SECTION //
  'web-app': {
    slug: 'web-app',
    title: 'Web App',
    description: 'Learn how to use the React-based client interface for agent operations.',
    category: 'Using LegionCode',
    toc: [
      { id: 'dashboard-roles', text: 'Layout Areas' },
      { id: 'starting-tasks', text: 'Assigning a Task' },
      { id: 'monitoring-runs', text: 'Monitoring Agent Outputs' },
    ],
    elements: [
      { type: 'paragraph', text: 'The LegionCode web interface is located in apps/web. It is built as a fast, responsive Single Page Application using React and Vite, styled with a technical dark color palette, prioritizing information density over visual noise.' },
      { type: 'heading', level: 2, id: 'dashboard-roles', text: 'Layout Areas' },
      { type: 'list', items: [
        'Workspace Selector: Top bar control to switch between connected GitHub repositories or local directories.',
        'Workspace Agent Panel: The left panel where you describe tasks, choose provider models (e.g. Claude 3.5 Sonnet, GPT-4o), and configure parameters.',
        'Run Terminal Streamer: Center container displaying live, detailed terminal logs, step progress, and full command traces in real-time.',
        'Interactive Diff Viewer: Right/bottom drawer rendering modified file trees and visual line-by-line diff changes.'
      ]},
      { type: 'heading', level: 2, id: 'starting-tasks', text: 'Assigning a Task' },
      { type: 'paragraph', text: 'To coordinate a task, click "Assign Task" inside your active workspace. Describe what needs fixing, selecting from the model matrix, and hit execute. The client compiles the prompt schema and posts it directly to the brain worker endpoint.' },
      { type: 'heading', level: 2, id: 'monitoring-runs', text: 'Monitoring Agent Outputs' },
      { type: 'paragraph', text: 'Once launched, you will see the active agent request details. Rather than keeping you in the dark, the Web App lists each file read/write request and every tool execution, giving complete clarity on agent behaviors.' },
    ]
  },

  'repositories': {
    slug: 'repositories',
    title: 'Repositories',
    description: 'Onboard and manage connected codebases inside your agent workspace.',
    category: 'Using LegionCode',
    toc: [
      { id: 'connecting-repos', text: 'Connecting a Repository' },
      { id: 'workspace-indexing', text: 'Directory Parsing' },
    ],
    elements: [
      { type: 'paragraph', text: 'LegionCode performs operations centered completely around connected code repositories. Agents inspect repository structure, index relevant types, and create local git working trees to store draft edits.' },
      { type: 'heading', level: 2, id: 'connecting-repos', text: 'Connecting a Repository' },
      { type: 'paragraph', text: 'During initialization, the web-app queries active repositories. You can link local file folders or use secure OAuth tokens.' },
      { type: 'callout', variant: 'todo', text: 'The GitHub App OAuth registration flow is currently a work-in-progress. For local testing, we recommend mounting paths or using direct SSH endpoint references.', title: 'OAuth Status' },
      { type: 'heading', level: 2, id: 'workspace-indexing', text: 'Directory Parsing' },
      { type: 'paragraph', text: 'Once onboarded, LegionCode builds a visual file explorer. Prior to passing command scopes to the agent, the backend scans standard structures to ensure the LLM receives minimal, optimized core files, bypassing large node_modules or assets directories.' },
    ]
  },

  'agents': {
    slug: 'agents',
    title: 'Agents',
    description: 'Understanding specialized agent capabilities, roles, and execution patterns.',
    category: 'Using LegionCode',
    toc: [
      { id: 'agent-tooling', text: 'Agent Tools & Capabilities' },
      { id: 'command-execution', text: 'Execution Bounds' },
    ],
    elements: [
      { type: 'paragraph', text: 'Coding agents in LegionCode are not simple LLM chatbots; they are active system operators equipped with structured terminal tools, search, and file editors to edit files autonomously.' },
      { type: 'heading', level: 2, id: 'agent-tooling', text: 'Agent Tools & Capabilities' },
      { type: 'list', items: [
        'Directory Scan: Allows the agent to recursively retrieve directory trees to gain contextual bearings.',
        'File Reader: Safe file-view hook restricted to workspace files, ensuring credentials files are not exposed.',
        'Strategic String Finder: Builtin line grep to search references across massive codebases without consuming heavy token limits.',
        'File Writer & Patcher: Applies specific replacement diff ranges or outputs full newly proposed contents cleanly.'
      ]},
      { type: 'heading', level: 2, id: 'command-execution', text: 'Execution Bounds' },
      { type: 'paragraph', text: 'Every agent operates within concrete execution borders. The host system intercepts agent actions, checks permissions, and redirects shell executions straight to active sandbox session APIs.' },
    ]
  },

  'runs': {
    slug: 'runs',
    title: 'Runs',
    description: 'The step-by-step lifecycle of an agent task execution thread.',
    category: 'Using LegionCode',
    toc: [
      { id: 'run-stages', text: 'The Lifecycle Loop' },
      { id: 'history-tracking', text: 'Trace Logs' },
    ],
    elements: [
      { type: 'paragraph', text: 'A Run represents the physical execution thread of a developer task. It is the core stateful object managed by apps/brain and synced with apps/web.' },
      { type: 'heading', level: 2, id: 'run-stages', text: 'The Lifecycle Loop' },
      {
        type: 'table',
        headers: ['Stage', 'Action', 'System Area Involved'],
        rows: [
          ['1. Prompting', 'Developer enters issue descriptives', 'apps/web -> apps/brain'],
          ['2. Contextualizing', 'Scanning repo files & compiling schemas', 'packages/execution-engine'],
          ['3. Deciding', 'Agent reviews workspace + emits tool calls', 'LLM Provider of Choice'],
          ['4. Execution', 'Runs commands & updates files in sandbox', 'apps/secure-agent-api'],
          ['5. Compiling Diffs', 'Extracts file differences & staging draft-branch', 'git engine / shared-types']
        ]
      },
      { type: 'heading', level: 2, id: 'history-tracking', text: 'Trace Logs' },
      { type: 'paragraph', text: 'For auditability, every execution step is saved under an incremental trace log, allowing team members to review previous model messages, raw provider responses, and terminal outputs long after the sandbox is destroyed.' },
    ]
  },

  'reviewing-diffs': {
    slug: 'reviewing-diffs',
    title: 'Reviewing Diffs',
    description: 'The visual merge-safeguard system to review changes before application.',
    category: 'Using LegionCode',
    toc: [
      { id: 'split-diffs', text: 'Split-Diff Visualizer' },
      { id: 'merging', text: 'Safe Approving' },
    ],
    elements: [
      { type: 'paragraph', text: 'No changes are ever pushed to your active upstream repository branch without review. LegionCode employs a robust, web-facing code differential screen designed to make inspections instantaneous.' },
      { type: 'heading', level: 2, id: 'split-diffs', text: 'Split-Diff Visualizer' },
      { type: 'paragraph', text: 'Upon completing tasks, the web client receives the file changes ledger. It displays a folder-based list with additions highlighted in green and deletions in red. Code blocks are compared side-by-side using high-performance diff editors.' },
      { type: 'heading', level: 2, id: 'merging', text: 'Safe Approving' },
      { type: 'list', items: [
        'Approve: Merges the agent draft-branch directly into your workspace branch or creates a GitHub PR.',
        'Reject: Discards all temporary sandbox edits and releases locked session variables safely.',
        'Iterate: Keeps the edits intact but launches a supplementary sub-task instructing the agent to revise specific lines of code based on user notes.'
      ]},
    ]
  },

  'parallel-tasks': {
    slug: 'parallel-tasks',
    title: 'Parallel Tasks',
    description: 'Coordinate multiple feature branches and agents at the same time.',
    category: 'Using LegionCode',
    toc: [
      { id: 'isolation-mechanics', text: 'Isolation Mechanics' },
      { id: 'multitasking', text: 'Working on Parallel Branches' },
    ],
    elements: [
      { type: 'paragraph', text: 'To solve complex requirements, you do not have to wait for a single agent to finish. LegionCode natively supports launching parallel tasks.' },
      { type: 'heading', level: 2, id: 'isolation-mechanics', text: 'Isolation Mechanics' },
      { type: 'paragraph', text: 'Because each agent task is mapped to a totally separate sandbox run ID, file modifications never clash. Each run is allocated its own ephemeral workspace area, ensuring complete safety from overlapping scripts.' },
      { type: 'heading', level: 2, id: 'multitasking', text: 'Working on Parallel Branches' },
      { type: 'paragraph', text: 'Developers can spawn an agent to add automated tests under branch A, while simultaneously commanding another agent to fix styling parameters under branch B, reviewing both diff sets in parallel tabs.' },
    ]
  },

  // EXECUTION SECTION //
  'execution-harness': {
    slug: 'execution-harness',
    title: 'Execution Harness',
    description: 'How the custom LegionCode execution engine coordinates agents, sandboxes, and models.',
    category: 'Execution',
    toc: [
      { id: 'components-coordination', text: 'Component Architecture' },
      { id: 'data-flow', text: 'Run Data Flow' },
    ],
    elements: [
      { type: 'paragraph', text: 'LegionCode is powered by a custom execution harness that acts as a low-latency connector between model decisions, remote APIs, and ephemeral containers. This layer replaces generic agent frameworks with a system designed exclusively for Cloudflare Workers environments.' },
      { type: 'heading', level: 2, id: 'components-coordination', text: 'Component Architecture' },
      { type: 'list', items: [
        'apps/brain: The orchestrator worker. It serves the public API, preserves run states, coordinates authentication, and initiates model loops.',
        'apps/secure-agent-api: The sandbox execution hub. It exposes secure endpoints to receive file system, search, and container instructions.',
        'packages/execution-engine: The runtime core. It provides system policies, formatters, code search tools (grepping), and command execution structures.',
        'packages/shared-types: The canonical contract definitions, housing TypeScript models, DTO validators, and JSON runtime definitions.'
      ]},
      { type: 'heading', level: 2, id: 'data-flow', text: 'Run Data Flow' },
      { type: 'paragraph', text: 'When a task executes, apps/brain instantiates the agent loop. For every tool call requested by the model, the execution-engine parses command structures and formats the exact payload, calling apps/secure-agent-api to invoke isolated operations securely.' },
    ]
  },

  'cloud-sandboxes': {
    slug: 'cloud-sandboxes',
    title: 'Cloud Sandboxes',
    description: 'Security, boundaries, and performance of isolated virtual environments.',
    category: 'Execution',
    toc: [
      { id: 'process-isolation', text: 'Process Isolation' },
      { id: 'safety-caps', text: 'Security Assertions' },
    ],
    elements: [
      { type: 'paragraph', text: 'Allowing LLMs to run arbitrary shell commands on local machines is a massive security vulnerability. LegionCode addresses this risk by channeling all run operations into isolated Cloud Sandboxes.' },
      { type: 'heading', level: 2, id: 'process-isolation', text: 'Process Isolation' },
      { type: 'paragraph', text: 'Whenever a bash command or build script is requested, the secure-agent-api interacts with ephemeral runtimes. Directory access is restricted entirely to the cloned repository tree, and processes are terminated immediately upon execution timeout.' },
      { type: 'heading', level: 2, id: 'safety-caps', text: 'Security Assertions' },
      { type: 'list', items: [
        'Read-Only Environment Limits: Crucial project settings files and credential folders are hidden from the agent environment.',
        'No host access: The hosting workspace server is decoupled from the worker sandboxes, protecting private networks.'
      ]},
    ]
  },

  'sessions': {
    slug: 'sessions',
    title: 'Sessions',
    description: 'Managing runtime sessions and environment persistence across iterations.',
    category: 'Execution',
    toc: [
      { id: 'session-persistence', text: 'Session Lifetime' },
      { id: 'mapping-ids', text: 'Session UUID Mapping' },
    ],
    elements: [
      { type: 'paragraph', text: 'To allow agents to iterate effectively (e.g. running build, receiving errors, revising code, rebuilding), execution environments must maintain state across model conversation turns.' },
      { type: 'heading', level: 2, id: 'session-persistence', text: 'Session Lifetime' },
      { type: 'paragraph', text: 'Each Sandbox session is assigned a specific, non-overlapping TTL (Time-To-Live). The session remains active during the active Task loop, keeping build caches and git staging trees hot.' },
      { type: 'heading', level: 2, id: 'mapping-ids', text: 'Session UUID Mapping' },
      { type: 'paragraph', text: 'The brain worker tracks and transfers the unique session IDs on every request, mapping task runs to their specific ephemeral secure-agent-api containers.' },
    ]
  },

  'debugging': {
    slug: 'debugging',
    title: 'Debugging',
    description: 'Interrogating runtime, querying diagnostic hooks, and troubleshooting environments.',
    category: 'Execution',
    toc: [
      { id: 'diagnostic-endpoints', text: 'Diagnostic Endpoints' },
      { id: 'command-usage', text: 'Command Line Queries' },
    ],
    elements: [
      { type: 'paragraph', text: 'LegionCode supports dense, cursor-inspired inspection capabilities to help devs audit active workers, evaluate execution performance, and troubleshoot pathing issues.' },
      { type: 'heading', level: 2, id: 'diagnostic-endpoints', text: 'Diagnostic Endpoints' },
      { type: 'paragraph', text: 'The monorepo workers export dedicated, highly verbose debug hooks. Run these tools to query physical configurations instantly.' },
      { type: 'heading', level: 2, id: 'command-usage', text: 'Command Line Queries' },
      { type: 'paragraph', text: 'Retrieve active service capabilities and runtime memory maps via curl:' },
      { type: 'code', code: `# Query current Brain worker status\ncurl http://localhost:8787/api/debug/runtime\n\n# Query Secure execution API status\ncurl http://localhost:8788/api/debug/runtime\n\n# Query specific active session parameters\ncurl "http://localhost:8788/api/debug/runtime?runId=<RUN_ID>"`, language: 'bash' },
      { type: 'callout', variant: 'info', text: 'Verify that the correct Wrangler environment bindings are active prior to running queries, as debug pathways require process authorizations.', title: 'Access Check' }
    ]
  },

  'validation-gates': {
    slug: 'validation-gates',
    title: 'Validation Gates',
    description: 'Enforcing codebase constraints, lint standards, and structural testing.',
    category: 'Execution',
    toc: [
      { id: 'gatekeeper-roles', text: 'Core Validation Gates' },
      { id: 'future-integration', text: 'Planned Automations' },
    ],
    elements: [
      { type: 'paragraph', text: 'Before proposing diff sets to developers, LegionCode runs custom check scripts to verify code soundness. This stops faulty changes or compile-breaking syntax issues early.' },
      { type: 'heading', level: 2, id: 'gatekeeper-roles', text: 'Core Validation Gates' },
      { type: 'list', items: [
        'TypeScript check: Validates that typescript files compile error-free across package levels.',
        'ESLint Linter checks: Runs code formatting inspections matching workspace rulesets.',
        'Unit check test suites: Automatically runs local package units to prevent functional regressions.'
      ]},
      { type: 'heading', level: 2, id: 'future-integration', text: 'Planned Automations' },
      { type: 'callout', variant: 'todo', text: 'Automating validation gates integration directly on incoming agent PRs is planned. Custom workspace compiler hooks configuration details are pending repository updates.', title: 'Integration Roadmap' }
    ]
  },

  // CONFIGURATION SECTION //
  'model-providers': {
    slug: 'model-providers',
    title: 'Model Providers',
    description: 'The supported, planed, and hidden model provider matrix.',
    category: 'Configuration',
    toc: [
      { id: 'routing-matrix', text: 'Routing Matrix Table' },
      { id: 'planned-providers', text: 'Planned & Coming Soon' },
    ],
    elements: [
      { type: 'paragraph', text: 'LegionCode supports direct BYOK routing to multiple global foundational model endpoints. The orchestrator maps uniform request packages to provider-specific formats.' },
      { type: 'heading', level: 2, id: 'routing-matrix', text: 'Routing Matrix Table' },
      {
        type: 'table',
        headers: ['Provider Identifier', 'Current Status', 'Key Binding Input'],
        rows: [
          ['OpenRouter', 'Fully Supported', 'OPENROUTER_API_KEY'],
          ['OpenAI', 'Fully Supported', 'OPENAI_API_KEY'],
          ['Anthropic', 'Fully Supported', 'ANTHROPIC_API_KEY'],
          ['Google (Gemini)', 'Fully Supported', 'GEMINI_API_KEY'],
          ['Groq', 'Fully Supported', 'GROQ_API_KEY'],
          ['Together AI', 'Fully Supported', 'TOGETHER_API_KEY'],
          ['Cerebras', 'Fully Supported', 'CEREBRAS_API_KEY'],
          ['OpenCode Go', 'Fully Supported', 'OPENCODE_GO_KEY'],
          ['OpenCode Zen', 'Fully Supported', 'OPENCODE_ZEN_KEY'],
          ['Mistral', 'Incomplete / Hidden', 'MISTRAL_API_KEY'],
          ['Cohere', 'Incomplete / Hidden', 'COHERE_API_KEY']
        ]
      },
      { type: 'heading', level: 2, id: 'planned-providers', text: 'Planned & Coming Soon' },
      { type: 'paragraph', text: 'Integration with Cloudflare AI and Cloudflare AI Gateway is currently marked as planned. We aim to support direct native binding routing under active cloud environments shortly.' },
    ]
  },

  'provider-keys': {
    slug: 'provider-keys',
    title: 'Provider Keys',
    description: 'Setting up and protecting model provider access keys.',
    category: 'Configuration',
    toc: [
      { id: 'byok-setup', text: 'BYOK Setup Guidance' },
      { id: 'key-security', text: 'Safe Credentials Storage' },
    ],
    elements: [
      { type: 'paragraph', text: 'Because LegionCode acts as private open-source infrastructure, you maintain complete custody of your API keys. You configure bindings to let your agents prompt provider LLMs.' },
      { type: 'heading', level: 2, id: 'byok-setup', text: 'BYOK Setup Guidance' },
      { type: 'paragraph', text: 'To make keys accessible, set correct environment variables in your brain worker configs or supply them dynamically inside the client-side browser header forms.' },
      { type: 'heading', level: 2, id: 'key-security', text: 'Safe Credentials Storage' },
      { type: 'callout', variant: 'todo', text: 'Remote secure secret store integrations (e.g. Cloudflare KV secrets or vault variables bindings) are pending deployment implementation. Never commit private API keys inside your git repositories.', title: 'Secret Bounds' },
    ]
  },

  'permissions': {
    slug: 'permissions',
    title: 'Permissions',
    description: 'Action enforcement, command bans, and workspace file limits.',
    category: 'Configuration',
    toc: [
      { id: 'permissions-boundaries', text: 'Enforcing Boundaries' },
    ],
    elements: [
      { type: 'paragraph', text: 'Giving access to code bases necessitates fine-grained authorization. LegionCode plans to implement strict command blocklist mechanisms.' },
      { type: 'heading', level: 2, id: 'permissions-boundaries', text: 'Enforcing Boundaries' },
      { type: 'paragraph', text: 'Currently, the agent is restricted by the secure-agent-api directory mapping boundaries, preventing file access outside the clone scope.' },
      { type: 'callout', variant: 'todo', text: 'Detailed permission parameters (e.g. allowed_paths, disallowed_commands blocks, system command bans) are currently undergoing active RFC design.', title: 'Future Permissions Model' },
    ]
  },

  'environment-variables': {
    slug: 'environment-variables',
    title: 'Environment Variables',
    description: 'Documenting the standard variables loaded by LegionCode workers & apps.',
    category: 'Configuration',
    toc: [
      { id: 'vars-matrix', text: 'Environment Variables Table' },
    ],
    elements: [
      { type: 'paragraph', text: 'Configure these environment parameters in your `.env` or Wrangler terminal boundaries to control monorepo applications routing and authorization rules.' },
      { type: 'heading', level: 2, id: 'vars-matrix', text: 'Environment Variables Table' },
      {
        type: 'table',
        headers: ['Variable Name', 'App/Package Target', 'Purpose / Scope', 'Required / Opt', 'Sample Value'],
        rows: [
          ['CLOUDFLARE_API_TOKEN', 'all apps', 'Auth to wrangler & wrangler deployments', 'Required', 'cf_tok_abcdef123'],
          ['SECURE_AGENT_SECRET', 'shared', 'Internal signature to prevent unwanted session calls', 'Required', 'sha256_sig_secret'],
          ['OPENROUTER_API_KEY', '@shadowbox/brain', 'API key for model prompting', 'Optional', 'sk-or-v1-301'],
          ['ANTHROPIC_API_KEY', '@shadowbox/brain', 'API key for Claude models prompting', 'Optional', 'sk-ant-1d3c0'],
          ['OPENAI_API_KEY', '@shadowbox/brain', 'API key for GPT-4 models prompting', 'Optional', 'sk-proj-abC921'],
          ['GEMINI_API_KEY', '@shadowbox/brain', 'API key for Google Gemini model access', 'Optional', 'AIzaSyA_bC_de'],
          ['GROQ_API_KEY', '@shadowbox/brain', 'Groq provider LLaMA access key', 'Optional', 'gsk_xZ024'],
          ['APP_URL', '@shadowbox/web', 'Hosting root URL for OAuth callback mappings', 'Required', 'https://legioncode.dev']
        ]
      }
    ]
  },

  'rules': {
    slug: 'rules',
    title: 'Rules',
    description: 'Injecting custom developer behaviors and repo directives.',
    category: 'Configuration',
    toc: [
      { id: 'custom-rulesets', text: 'Providing Custom System Instructions' },
    ],
    elements: [
      { type: 'paragraph', text: 'Instructing agents about your team code styles, lint requirements, or architecture patterns is crucial for repeatable high-quality output.' },
      { type: 'heading', level: 2, id: 'custom-rulesets', text: 'Providing Custom System Instructions' },
      { type: 'paragraph', text: 'You can configure custom instructions or directives within the workspace setup to be appended as persistent system prompts to every model invocation.' },
      { type: 'callout', variant: 'info', text: 'Do not claim explicit AGENTS.md support unless the codebase integrates it. Currently rules are parsed directly from text configurations on the Workspace UI.', title: 'Rules Scope' }
    ]
  },

  // SELF HOSTING SECTION //
  'local-development': {
    slug: 'local-development',
    title: 'Local Development',
    description: 'Instructions to construct developer testing and contribution rigs.',
    category: 'Self-hosting',
    toc: [
      { id: 'cloning-local', text: 'Initial Local setup' },
      { id: 'mocking-sandbox', text: 'Mocking Sandbox' },
      { id: 'monorepo-runs', text: 'Monorepo Operations' },
    ],
    elements: [
      { type: 'paragraph', text: 'This guide outlines instructions for contributors wishing to modify the core monorepo, test the worker routines, and optimize custom search indexes.' },
      { type: 'heading', level: 2, id: 'cloning-local', text: 'Initial Local setup' },
      { type: 'paragraph', text: 'Use PNPM workspaces to boot all dependencies concurrently during development:' },
      { type: 'code', code: `pnpm install\npnpm dev`, language: 'bash' },
      { type: 'heading', level: 2, id: 'mocking-sandbox', text: 'Mocking Sandbox' },
      { type: 'paragraph', text: 'By default, running pnpm dev starts apps/secure-agent-api in Wrangler dev mode, which replicates the cloud sandboxing execution APIs locally using node-level file directories.' },
      { type: 'heading', level: 2, id: 'monorepo-runs', text: 'Monorepo Operations' },
      { type: 'paragraph', text: 'Ensure you execute lint validators prior to making modifications to the repository boundaries:' },
      { type: 'code', code: `pnpm lint\npnpm build`, language: 'bash' },
    ]
  },

  'cloudflare-setup': {
    slug: 'cloudflare-setup',
    title: 'Cloudflare Setup',
    description: 'Deploying workers, routing wrangler configs, and binding secrets.',
    category: 'Self-hosting',
    toc: [
      { id: 'wrangler-setup', text: 'Wrangler Configuration' },
      { id: 'deploy-commands', text: 'Deploying Worker Services' },
    ],
    elements: [
      { type: 'paragraph', text: 'LegionCode runs as modular, serverless services under the Cloudflare ecosystem, reducing server bills and avoiding persistent node servers.' },
      { type: 'heading', level: 2, id: 'wrangler-setup', text: 'Wrangler Configuration' },
      { type: 'paragraph', text: 'Check the configuring lines inside the wrangler.toml files located inside apps/brain and apps/secure-agent-api. Configure your Cloudflare account ID and binding setups.' },
      { type: 'heading', level: 2, id: 'deploy-commands', text: 'Deploying Worker Services' },
      { type: 'paragraph', text: 'Launch direct deployment commands straight from the monorepo workspace:' },
      { type: 'code', code: `# Deploy Brain Orchestrator\npnpm --filter @shadowbox/brain deploy\n\n# Deploy Sandbox Execution API\npnpm --filter @shadowbox/secure-agent-api deploy`, language: 'bash' },
      { type: 'callout', variant: 'todo', text: 'Cloudflare Durable Objects deployment configurations or manual R2 bucket setup specifications are currently incomplete and under development.', title: 'Infrastructure TODO' },
    ]
  },

  'deployment': {
    slug: 'deployment',
    title: 'Deployment',
    description: 'Continuous delivery pathways and production staging outlines.',
    category: 'Self-hosting',
    toc: [
      { id: 'approaching-prod', text: 'Production Paths' },
    ],
    elements: [
      { type: 'paragraph', text: 'As LegionCode is in Public Alpha, early users are encouraged to deploy staging environments rather than open public production routes, as authorization borders are undergo audits.' },
      { type: 'heading', level: 2, id: 'approaching-prod', text: 'Production Paths' },
      { type: 'paragraph', text: 'Utilize GitHub Actions pipelines to deploy your Wrangler workers automatically upon main branch pushes, setting the required secret tokens key-value lists inside repository settings.' },
    ]
  },

  'troubleshooting': {
    slug: 'troubleshooting',
    title: 'Troubleshooting',
    description: 'Diagnosing common issues, port blocks, and failed model promptings.',
    category: 'Self-hosting',
    toc: [
      { id: 'common-errors', text: 'Error Diagnosis Lists' },
      { id: 'key-mismatches', text: 'Sandbox & Key Failures' },
    ],
    elements: [
      { type: 'paragraph', text: 'Encountering issues during local builds? Check this developer checklist to resolve local system conflicts quickly.' },
      { type: 'heading', level: 2, id: 'common-errors', text: 'Error Diagnosis Lists' },
      {
        type: 'features',
        items: [
          { title: 'Web app fails to boot / port conflicts', desc: 'Verify that there is no existing Node.js or static server binding port 3000. Terminate old processes with standard task manager or sh commands.' },
          { title: 'Brain worker (8787) is not responding', desc: 'Ensure wrangler is installed and that you authorized local workers using npx wrangler login before executing dev commands.' },
          { title: 'Secure Agent API (8788) unavailable', desc: 'Check that SECURE_AGENT_SECRET aligns across your .env files so requests are authorized.' }
        ]
      },
      { type: 'heading', level: 2, id: 'key-mismatches', text: 'Sandbox & Key Failures' },
      { type: 'paragraph', text: 'If you receive empty completions from OpenRouter or other providers, inspect your developer terminal logs. Ensure that the keys are not truncated and that your account balance supports deep prompting.' },
    ]
  },

  // REFERENCE SECTION //
  'repo-structure': {
    slug: 'repo-structure',
    title: 'Repo Structure',
    description: 'Physical contents map of the LegionCode monorepo packages.',
    category: 'Reference',
    toc: [
      { id: 'monorepo-map', text: 'Workspace Directory Map' },
    ],
    elements: [
      { type: 'paragraph', text: 'Here is the comprehensive structural overview of the Monorepo folders. Understanding this prevents path syntax typos when updating package relations.' },
      { type: 'heading', level: 2, id: 'monorepo-map', text: 'Workspace Directory Map' },
      {
        type: 'table',
        headers: ['Folder Path', 'Package Name', 'Role'],
        rows: [
          ['/apps/web', '@shadowbox/web', 'React + Vite developer workspace front-end UI.'],
          ['/apps/brain', '@shadowbox/brain', 'Orchestrating Cloudflare Worker mapping model interactions & sync data.'],
          ['/apps/secure-agent-api', '@shadowbox/secure-agent-api', 'Sandbox session manager Worker executing container scripts.'],
          ['/packages/execution-engine', '@shadowbox/execution-engine', 'Low-level code search engines & file modifications core.'],
          ['/packages/shared-types', '@shadowbox/shared-types', 'Canonical contracts, typescript models, and API boundaries.']
        ]
      }
    ]
  },

  'package-scripts': {
    slug: 'package-scripts',
    title: 'Package Scripts',
    description: 'Documenting the executable scripts found in package.json manifest files.',
    category: 'Reference',
    toc: [
      { id: 'core-scripts', text: 'Active Monorepo Scripts' },
    ],
    elements: [
      { type: 'paragraph', text: 'Execute these standardized directives from the root folder to manage monorepo processes:' },
      { type: 'heading', level: 2, id: 'core-scripts', text: 'Active Monorepo Scripts' },
      {
        type: 'table',
        headers: ['Command', 'Action / Execution Target', 'Environments scope'],
        rows: [
          ['pnpm dev', 'Launches web, brain, and secure-agent-api simultaneously', 'Development setup'],
          ['pnpm build', 'Compiles the react frontend & checks typing across directories', 'Prep build checks'],
          ['pnpm lint', 'Analyzes files using ESLint static patterns', 'Static diagnostics'],
          ['pnpm clean', 'Clears build logs and node caches', 'Maintenance']
        ]
      }
    ]
  },

  'api-reference': {
    slug: 'api-reference',
    title: 'API Reference',
    description: 'Public API boundaries, ports, and JSON REST routes documentation.',
    category: 'Reference',
    toc: [
      { id: 'brain-endpoints', text: 'Brain Worker Endpoints' },
      { id: 'secure-endpoints', text: 'Secure API Endpoints' },
    ],
    elements: [
      { type: 'paragraph', text: 'LegionCode services communicate using lightweight JSON payloads over standard REST pathways. This reference allows developers to connect external triggers directly.' },
      { type: 'heading', level: 2, id: 'brain-endpoints', text: 'Brain Worker Endpoints (Port 8787)' },
      { type: 'list', items: [
        'POST /api/tasks: Dispatch a task string requesting code edits. Params block: { task: string, model: string }',
        'GET /api/tasks/:id: Access details of an active task run, listing progress stats, steps, and changed files list.'
      ]},
      { type: 'heading', level: 2, id: 'secure-endpoints', text: 'Secure API Endpoints (Port 8788)' },
      { type: 'list', items: [
        'POST /api/execution/sandbox: Dispatch container execution loops. Params block: { runId: string, cmd: string }'
      ]},
      { type: 'callout', variant: 'todo', text: 'The precise specifications for integration OAuth endpoints, and webhook diff signals export APIs are pending final Beta release blueprints.', title: 'REST TODO' }
    ]
  },

  'changelog': {
    slug: 'changelog',
    title: 'Changelog',
    description: 'LegionCode development history and release schedules.',
    category: 'Reference',
    toc: [
      { id: 'alpha-release', text: 'Initial Public Alpha (v0.0.1-alpha.1)' },
    ],
    elements: [
      { type: 'paragraph', text: 'Keep track of the iterative architecture upgrades and code additions below.' },
      { type: 'heading', level: 2, id: 'alpha-release', text: 'Initial Public Alpha (v0.0.1-alpha.1)' },
      { type: 'paragraph', text: 'Released on: June 10, 2026. This release introduces the foundational execution framework architecture:' },
      { type: 'list', items: [
        'Added central orchestrating Worker apps/brain.',
        'Added Sandbox environment communication hook secure-agent-api.',
        'Structured shared contracts typing library packages/shared-types.',
        'Initial BYOK support linking OpenAI, Anthropic, Gemini, OpenRouter & Groq providers.',
        'Friction-free React terminal log streamer apps/web interface.'
      ]}
    ]
  }
};
