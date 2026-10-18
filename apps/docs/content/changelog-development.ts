import type { ChangelogRelease } from "@/lib/changelog";

// Development milestones before the private-alpha launch. Dates use merged PRs
// or, before the first PR, recorded commit times in Asia/Kolkata. These describe
// the prototype at the time; they are not historical public release versions.
export const developmentReleases: ChangelogRelease[] = [
  {
    id: "development-chat-and-review-state",
    title: "Chat history and saved changes",
    date: "2026-06-21",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Saved tool activity and progress messages with the request that produced them.",
          "Saved complete diffs and line counts so changes could be reviewed after a workspace restart.",
          "Fixed older history replacing newer messages when it finished loading. Chat activity reconnected after temporary connection failures.",
        ],
      },
    ],
    pullRequests: [351],
  },
  {
    id: "development-workspace-file-tabs",
    title: "Workspace file tabs and review layout",
    date: "2026-06-20",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added file tabs and previews. Diffs could be collapsed or expanded to show surrounding lines.",
          "Adjusted branch and permission menus and fixed wrapped file content in the review sidebar.",
        ],
      },
    ],
    pullRequests: [349],
  },
  {
    id: "development-saved-review-selection",
    title: "Review the selected saved edit",
    date: "2026-06-17",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added review of earlier edits even after more changes had been made in the workspace.",
          "Fixed saved edit cards changing to show later versions of a file.",
        ],
      },
    ],
    pullRequests: [343],
  },
  {
    id: "development-chat-recovery",
    title: "Chat switching and review recovery",
    date: "2026-06-16",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Fixed messages from the previous chat appearing after switching chats.",
          "Fixed missing files in Review and removed duplicate progress rows and Thinking indicators left behind after completion.",
        ],
      },
    ],
    pullRequests: [331],
  },
  {
    id: "development-deployment-preparation",
    title: "Private-alpha deployment preparation",
    date: "2026-06-12",
    phase: "development",
    sections: [
      {
        category: "platform",
        title: "Platform",
        items: [
          "Prepared the hosted API and coding sandbox for the private alpha, including storage and access controls.",
          "Fixed the public /agents path so scripts and assets could load through the site proxy.",
        ],
      },
    ],
    pullRequests: [330, 328],
  },
  {
    id: "development-separate-public-site",
    title: "A separate public website",
    date: "2026-06-04",
    phase: "development",
    sections: [
      {
        category: "platform",
        title: "Platform",
        items: [
          "Separated website updates from workspace updates so each could be built and deployed on its own.",
          "Kept the agent workspace at /agents and retained redirects for the earlier app URLs.",
        ],
      },
    ],
    pullRequests: [306],
  },
  {
    id: "development-first-landing-page",
    title: "The first private-alpha landing page",
    date: "2026-06-03",
    phase: "development",
    sections: [
      {
        category: "platform",
        title: "Platform",
        items: [
          "Added a landing page and Cloud page with private-alpha access information and a preview of coding tasks and change review.",
          "Added LegionCode icons, social previews, and the /agents workspace route.",
        ],
      },
    ],
    pullRequests: [302],
  },
  {
    id: "development-code-navigation",
    title: "File and code search",
    date: "2026-06-03",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "The agent could search file names and contents and browse the repository's folder tree.",
          "Large file reads showed how much was read and how to continue from the remaining content.",
        ],
      },
    ],
    pullRequests: [304],
  },
  {
    id: "development-approval-waits",
    title: "Approve or deny actions in chat",
    date: "2026-06-02",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added an approval panel that stayed visible until a request was answered.",
          "Tasks waiting for approval stayed marked as waiting instead of appearing complete.",
        ],
      },
    ],
    pullRequests: [301],
  },
  {
    id: "development-saved-review-diffs",
    title: "Saved diffs linked to replies",
    date: "2026-06-02",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Each assistant reply could open the edits made for that request.",
          "Separated current Git changes from saved edits in Review and refreshed saved changes when a task finished.",
        ],
      },
    ],
    pullRequests: [300, 299],
  },
  {
    id: "development-provider-choices",
    title: "OpenCode and Cloudflare provider choices",
    date: "2026-06-01",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "Added OpenCode Zen, OpenCode Go, and Cloudflare AI connections to the prototype, including their model lists.",
          "The model picker and Manage Models showed which models were unavailable and what was needed to connect them.",
        ],
      },
    ],
    pullRequests: [298, 282, 283, 284, 285, 291, 296, 297],
  },
  {
    id: "development-activity-history",
    title: "Saved activity and provider errors",
    date: "2026-06-01",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Reopened chats could show earlier tool calls, approvals, progress messages, and provider errors.",
          "Recoverable provider errors paused the task instead of leaving the loading indicator running.",
        ],
      },
    ],
    pullRequests: [295, 292, 293, 294],
  },
  {
    id: "development-image-prototype",
    title: "The first image-attachment flow",
    date: "2026-06-01",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added image pasting with thumbnail previews and a way to remove images before sending.",
          "Checked image type, size, attachment count, and model support before sending. Image contents were excluded from debug logs.",
        ],
      },
    ],
    pullRequests: [290, 287, 288, 289],
  },
  {
    id: "development-saved-edit-review",
    title: "Review earlier edits from chat",
    date: "2026-05-31",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added saved file lists and diffs that could be opened from chat messages.",
          "Earlier edits could be reviewed after the workspace's files had changed again.",
        ],
      },
    ],
    pullRequests: [281],
  },
  {
    id: "development-organize-chats",
    title: "Rename, pin, and archive chats",
    date: "2026-05-28",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added chat renaming, pinning, archiving, and restoring archived chats.",
          "Added automatic chat titles, a pinned group in the sidebar, and archived chats in Settings.",
        ],
      },
    ],
    pullRequests: [280],
  },
  {
    id: "development-final-replies",
    title: "Final replies and task errors",
    date: "2026-05-28",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Tasks were marked complete only after their final reply was saved.",
          "Denied actions and failed tasks showed an explanation instead of an empty response or raw tool output.",
        ],
      },
    ],
    pullRequests: [279],
  },
  {
    id: "development-git-diff-recovery",
    title: "Diffs across restarts and Git filename fixes",
    date: "2026-05-27",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Saved diffs and line counts across restarts, with support for renamed files and filenames containing spaces or special characters.",
          "Fixed task execution using the chat's previous run instead of the current request.",
        ],
      },
    ],
    pullRequests: [278],
  },
  {
    id: "development-session-switching",
    title: "Switch chats without restarting them",
    date: "2026-05-25",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Fixed selecting an existing chat restarting it or crashing the workspace when task details were missing.",
          "Chats showed when history was loading or unavailable. Sending was disabled until history finished loading.",
        ],
      },
    ],
    pullRequests: [277],
  },
  {
    id: "development-persistence-fixes",
    title: "Chat loading and workspace fixes",
    date: "2026-05-24",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Fixed saved chats loading without their history or chat details and checked access before returning history.",
          "Kept tasks' Git workspaces separate and fixed cancelled tasks later appearing completed.",
          "Fixed restoring saved edits and reduced repeated activity and Git-status warnings.",
        ],
      },
    ],
    pullRequests: [
      276, 261, 262, 263, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275,
    ],
  },
  {
    id: "development-postgres-history",
    title: "Accounts and chat history moved to Postgres",
    date: "2026-05-18",
    phase: "development",
    sections: [
      {
        category: "platform",
        title: "Platform",
        items: [
          "Moved accounts, repository choices, provider connections, chat history, permissions, and saved-edit records from D1 and KV to Postgres.",
          "Verified incoming task updates and saved messages in order without duplicate copies.",
        ],
      },
    ],
    pullRequests: [260, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259],
  },
  {
    id: "development-artifact-display",
    title: "Saved edits and chat previews",
    date: "2026-05-13",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added saved edit previews to chat.",
          "Adjusted preview widths and linked each file change to the assistant reply that made it.",
        ],
      },
    ],
    pullRequests: [248, 247],
  },
  {
    id: "development-changed-files-cards",
    title: "Changed-files cards and sidebar review",
    date: "2026-05-10",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Changed-files cards showed file counts and added or removed lines, with an expandable file list and a Review button.",
          "Updated the right sidebar so file changes and review used more of the available space.",
        ],
      },
    ],
    pullRequests: [246, 243],
  },
  {
    id: "development-review-comments",
    title: "Send review comments back to the agent",
    date: "2026-05-07",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added comments on diffs that could be sent to the agent with the next message.",
          "Attached comments showed the file, line, code preview, and note before sending.",
        ],
      },
    ],
    pullRequests: [242],
  },
  {
    id: "development-settings-dialog",
    title: "Provider connections in Settings",
    date: "2026-05-02",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added Settings to the sidebar.",
          "Provider errors offered a link to Settings → Connect to fix the connection.",
        ],
      },
    ],
    pullRequests: [238],
  },
  {
    id: "development-github-command-tools",
    title: "GitHub command tools",
    date: "2026-04-27",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "The agent could use supported GitHub CLI commands and read through the GitHub connector.",
          "GitHub actions checked your account's access, and changes such as posting PR comments required approval.",
        ],
      },
    ],
    pullRequests: [231, 229],
  },
  {
    id: "development-permission-controls",
    title: "Permission modes and approval requests",
    date: "2026-04-18",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added permission-mode controls to setup and saved chats.",
          "Actions needing permission asked for approval in chat and showed a waiting status in the task sidebar.",
        ],
      },
    ],
    pullRequests: [228, 227],
  },
  {
    id: "development-first-run-setup",
    title: "First-run repository and provider setup",
    date: "2026-04-12",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added guided setup for choosing a repository and connecting a provider with your API key.",
          "Updated the message box, file mentions, and instructions shown before the first message.",
        ],
      },
    ],
    pullRequests: [226, 225],
  },
  {
    id: "development-openrouter-recommendations",
    title: "OpenRouter model recommendations",
    date: "2026-04-11",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "Replaced Popular with Recommended models based on the coding models available to your connected OpenRouter account.",
          "Saved your account's model list for later loading.",
        ],
      },
    ],
    pullRequests: [224],
  },
  {
    id: "development-github-workflow",
    title: "GitHub commits, branches, and PR recovery",
    date: "2026-04-05",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Fixed follow-up requests switching back to the original repository branch instead of keeping the task's branch.",
          "Improved recovery after failed pulls and error messages for missing branches and rejected pushes. GitHub activity appeared in chat.",
        ],
      },
    ],
    pullRequests: [221],
  },
  {
    id: "development-provider-catalog",
    title: "More provider connections",
    date: "2026-04-01",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "Added Google, Together AI, and Cerebras connections.",
          "The provider list showed only connections supported by the prototype.",
        ],
      },
    ],
    pullRequests: [218],
  },
  {
    id: "development-saved-model-visibility",
    title: "Saved model choices and Manage Models",
    date: "2026-03-31",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "Fixed hidden models reappearing when switching chats.",
          "Added a shortcut to Manage Models after connecting a provider.",
        ],
      },
    ],
    pullRequests: [217],
  },
  {
    id: "development-commentary",
    title: "Progress messages alongside tool activity",
    date: "2026-03-31",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Separated progress messages from the final answer.",
          "Messages about recovering from errors stayed visible with the task's activity.",
        ],
      },
    ],
    pullRequests: [216],
  },
  {
    id: "development-git-review",
    title: "Git review popup",
    date: "2026-03-27",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "The Commit button opened a review popup with Git status, diffs, staging, and commit actions.",
          "Disabled controls for actions that were not yet available.",
        ],
      },
    ],
    pullRequests: [212],
  },
  {
    id: "development-inline-workflow",
    title: "Tool activity inside the conversation",
    date: "2026-03-26",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added a compact activity timeline with expandable tool details.",
          "Attached live activity to the request that produced it and kept completed work in collapsible summaries.",
          "Git checks showed the command being run.",
        ],
      },
    ],
    pullRequests: [211, 207, 209, 210],
  },
  {
    id: "development-plan-mode",
    title: "Plan before building",
    date: "2026-03-24",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added Plan and Build choices to the message box and setup.",
          "Plan mode saved a plan without making code changes and offered a switch to Build when ready.",
        ],
      },
    ],
    pullRequests: [208, 201],
  },
  {
    id: "development-user-provider-keys",
    title: "Provider keys shared across a user's tasks",
    date: "2026-03-22",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "Saved API keys with AES-256-GCM encryption and linked connections to your account.",
          "A provider connection could be reused across tasks while keeping separate preferences for each workspace.",
        ],
      },
    ],
    pullRequests: [198, 196, 197],
  },
  {
    id: "development-agent-tool-loop",
    title: "The agent could use tools and continue working",
    date: "2026-03-15",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "The agent could use a tool, read its result, and continue working on the request.",
          "Added file reading and editing, shell commands, Git status and diff, and file and text search.",
          "The agent could read several files at once while applying edits one at a time.",
        ],
      },
    ],
    pullRequests: [187, 171, 172, 174, 177, 178],
  },
  {
    id: "development-markdown-replies",
    title: "Markdown chat replies",
    date: "2026-03-14",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Rendered formatted Markdown in chat, including code blocks and links.",
        ],
      },
    ],
    pullRequests: [179],
  },
  {
    id: "development-new-task-sidebar",
    title: "New Task and sidebar updates",
    date: "2026-03-11",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Updated task rows and sidebar navigation. New Task used the provider selected in the message box.",
          "Git status and diffs loaded when a workspace was selected, before the first message.",
        ],
      },
    ],
    pullRequests: [165],
  },
  {
    id: "development-idle-model-switch",
    title: "Switch models between requests",
    date: "2026-03-10",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "Added model switching between requests in the same chat.",
          "Showed a warning before switching models in a chat that already had messages.",
        ],
      },
    ],
    pullRequests: [164],
  },
  {
    id: "development-dynamic-model-discovery",
    title: "Model lists from connected providers",
    date: "2026-03-05",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "The model picker loaded available models from connected OpenRouter and Google accounts.",
          "Model lists could be refreshed and were saved for later loading.",
        ],
      },
    ],
    pullRequests: [143, 141, 135, 136, 137, 138, 139],
  },
  {
    id: "development-manage-models",
    title: "Choose which models appear in the picker",
    date: "2026-03-02",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "Added Manage Models to search models by provider and choose which ones appear in the picker.",
          "Saved hidden-model choices and adjusted the picker to fit near the bottom of the screen.",
        ],
      },
    ],
    pullRequests: [108, 107, 109, 110, 111],
  },
  {
    id: "development-composer-model-picker",
    title: "A searchable model picker in the composer",
    date: "2026-03-02",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "Added model search grouped by provider, with the selected model marked.",
          "Added Connect Provider and Manage Models shortcuts, provider search, and API-key format hints.",
        ],
      },
    ],
    pullRequests: [106, 105],
  },
  {
    id: "development-provider-recovery",
    title: "Provider setup and connection recovery",
    date: "2026-02-28",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "Added chat with streamed replies using one connected provider.",
          "Connection errors offered a way to reopen provider setup from chat.",
        ],
      },
    ],
    pullRequests: [95, 88, 89, 90, 94],
  },
  {
    id: "development-provider-dialog",
    title: "Connect and manage providers in one place",
    date: "2026-02-23",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "Added one dialog to connect a provider, check its API key, disconnect it, and save preferences.",
          "Fixed messages failing when sent before provider setup finished loading.",
        ],
      },
    ],
    pullRequests: [76, 63, 67, 68, 70, 72, 73, 75, 77, 78],
  },
  {
    id: "development-provider-validation",
    title: "Provider connection access checks",
    date: "2026-02-22",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "Restricted saved provider connections to the account that created them.",
          "Limited repeated API-key checks and recorded connection-check activity.",
        ],
      },
    ],
    pullRequests: [69, 62, 66],
  },
  {
    id: "development-openrouter-groq",
    title: "Use OpenRouter and Groq in chat",
    date: "2026-02-19",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "Chats used the provider and model selected in the message box.",
          "Added direct OpenRouter and Groq connections using your API key.",
        ],
      },
    ],
    pullRequests: [49, 45, 46, 48],
  },
  {
    id: "development-multi-session",
    title: "Saved settings for each chat",
    date: "2026-02-17",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Each chat kept its own conversation, repository, and model choices.",
          "Added saved chats and switching between conversations.",
        ],
      },
    ],
    pullRequests: [43],
  },
  {
    id: "development-byok-settings",
    title: "The first bring-your-own-key settings",
    date: "2026-02-17",
    phase: "development",
    sections: [
      {
        category: "providers",
        title: "Providers",
        items: [
          "Added settings to connect a provider with your API key, validate the key, and choose a model for each chat.",
        ],
      },
    ],
    pullRequests: [42, 41],
  },
  {
    id: "development-run-inbox",
    title: "A task inbox",
    date: "2026-02-17",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added a task inbox with filters for queued, running, waiting, failed, and completed tasks.",
          "Saved the selected workspace, chat, and right-panel view in the browser.",
        ],
      },
    ],
    pullRequests: [40],
  },
  {
    id: "development-memory",
    title: "Saved task memory and checkpoints",
    date: "2026-02-15",
    phase: "development",
    sections: [
      {
        category: "platform",
        title: "Platform",
        items: [
          "Added prototype storage to save task context, find relevant earlier information, and load saved checkpoints.",
        ],
      },
    ],
    pullRequests: [37, 36],
  },
  {
    id: "development-planning-and-cost",
    title: "Task planning and cost controls",
    date: "2026-02-14",
    phase: "development",
    sections: [
      {
        category: "platform",
        title: "Platform",
        items: [
          "Added prototype task plans with ordered steps, checks for dependent steps, scheduling, and retries.",
          "Recorded model usage and costs, with configurable budget warnings and limits.",
        ],
      },
    ],
    pullRequests: [34, 29, 30, 33],
  },
  {
    id: "development-execution-backends",
    title: "Prototype Docker and cloud sandboxes",
    date: "2026-02-12",
    phase: "development",
    sections: [
      {
        category: "platform",
        title: "Platform",
        items: [
          "Added prototypes for running commands in local Docker containers and remote sandboxes, with live logs and time limits.",
          "Began adding cost tracking for sandbox execution.",
        ],
      },
    ],
    pullRequests: [27, 25, 26],
  },
  {
    id: "development-execution-records",
    title: "Saved task activity and outputs",
    date: "2026-02-11",
    phase: "development",
    sections: [
      {
        category: "platform",
        title: "Platform",
        items: [
          "Added prototype records for task activity, tool calls, and snapshots of generated files.",
          "Generated outputs could be held in memory or saved to disk.",
        ],
      },
    ],
    pullRequests: [22, 19, 20, 21],
  },
  {
    id: "development-context-budget",
    title: "Repository context and token budgets",
    date: "2026-02-11",
    phase: "development",
    sections: [
      {
        category: "platform",
        title: "Platform",
        items: [
          "Added repository scanning to gather code for model requests.",
          "Estimated token usage and prioritized which context to include within the request's budget.",
        ],
      },
    ],
    pullRequests: [16, 11, 13, 14, 15],
  },
  {
    id: "development-github-connection",
    title: "Connect a GitHub repository",
    date: "2026-02-09",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: ["Added GitHub sign-in and repository selection for each chat."],
      },
    ],
    pullRequests: [8],
  },
  {
    id: "development-diff-sidebar",
    title: "The first Git diff sidebar",
    date: "2026-02-06",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added a changed-files list, line-by-line diffs, and status and commit controls to the workspace sidebar.",
        ],
      },
    ],
    pullRequests: [5],
  },
  {
    id: "development-workspace-redesign",
    title: "The first workspace redesign",
    date: "2026-02-06",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Reworked the chat, task sidebar, top navigation, and workspace panels.",
          "Added chat headers, file labels, and change counts.",
        ],
      },
    ],
    pullRequests: [3],
  },
  {
    id: "development-persistence-engine",
    title: "Saved chats and history",
    date: "2026-02-03",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added saved chats and conversation history to the workspace.",
          "Setup and the task sidebar could load existing conversations.",
        ],
      },
    ],
    pullRequests: [1],
  },
  {
    id: "development-history-and-storage",
    title: "Saved history and generated files",
    date: "2026-01-30",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Saved chat history as work progressed and added cloud storage for generated files.",
          "Fixed older messages being executed again when restoring a conversation.",
        ],
      },
    ],
    commits: [
      "3075251c77ee3bff2a5087e3e5efe5413ba127df",
      "dbf8310621e39c9f8707c08fd4ae452503372406",
      "935d71d2d0d5cdc3bd2125b48feb48c0205d3789",
    ],
  },
  {
    id: "development-artifact-previews",
    title: "Previews of generated code",
    date: "2026-01-29",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added previews of generated code and loading of saved chats.",
          "Kept conversations in memory while switching between them.",
        ],
      },
    ],
    commits: [
      "1dd81fb99514d8df8e8481bf8c225fb5f98f3cd0",
      "daee0b10948074056b02d5ca951251ef123fcff7",
      "9711188078398fd284d53694538a41532df175dd",
    ],
  },
  {
    id: "development-tools-and-artifacts",
    title: "Git tools and visible agent actions",
    date: "2026-01-28",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Added action details and a view of generated files alongside chat.",
          "Expanded the agent's file tools and Git diff and commit actions.",
        ],
      },
    ],
    commits: [
      "b56b2bf9969361ec281f3d62e46db7b998228b7f",
      "56c008426655adb1637acc3383f9c568705186cf",
      "12b1d74b50f70d9fb2ed049d0148e123d8ef7616",
    ],
  },
  {
    id: "development-first-agent-loop",
    title: "The first chat connected to command execution",
    date: "2026-01-27",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Connected chat to model requests and command execution, with terminal feedback in the prototype.",
        ],
      },
    ],
    commits: [
      "6cf23b49ae5c431f99c8d758d778912cb647899d",
      "3b18c4b87de78865c24c3821057ca73b3f6e3817",
      "dddfcdd511cf1a618fb77608e616bc12728be06a",
    ],
  },
  {
    id: "development-coding-sandbox",
    title: "Node and Rust in the coding sandbox",
    date: "2026-01-25",
    phase: "development",
    sections: [
      {
        category: "platform",
        title: "Platform",
        items: [
          "Added Node and Rust tooling to the prototype coding sandbox and updated how its tools started.",
        ],
      },
    ],
    commits: [
      "e4c9ea209de13f0fe76f9d7c23c8ef9bbab03dcb",
      "ac5c24bd043ee58888c852a3afe62d0afcec9df8",
      "e297bb59e2ae826302a91b639e67a32d7d5f6607",
    ],
  },
  {
    id: "development-project-start",
    title: "The first Shadowbox workspace",
    date: "2026-01-24",
    phase: "development",
    sections: [
      {
        category: "product",
        title: "Updates",
        items: [
          "Started Shadowbox with a web workspace and a service for running code.",
          "Added multiple terminal sessions and a file explorer.",
        ],
      },
    ],
    commits: [
      "fcf40c8e24db01c2ff8b75a0eac5d7aa5a1a0aae",
      "96163a8307cdb37ac0736444be98f432bd5b7b0f",
      "391fffa33755b6174c03cb21c8f2c2bb74b100b6",
      "4ad43d4695f39fbc64c67fef660c9b54babaa5d0",
    ],
  },
];
