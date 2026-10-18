import type { ChangelogRelease } from "@/lib/changelog";
import { developmentReleases } from "./changelog-development";

// Keep the original launch copy and date as published.
export const launchRelease: ChangelogRelease = {
  id: "v0-1-0-private-alpha",
  title: "v0.1.0 Private Alpha",
  date: "2026-06-22",
  phase: "launch",
  sections: [
    {
      category: "product",
      title: "Product",
      items: [
        "Opened the hosted web workspace for approved private-alpha GitHub accounts.",
        "Added repository and branch selection for scoped coding-agent tasks.",
        "Added isolated cloud workspaces for independent runs.",
        "Added changed-file summaries and unified or split diff review before Git actions.",
        "Added permission modes for supervised work, automatic edits, same-repository actions, and full access.",
      ],
    },
    {
      category: "providers",
      title: "Providers",
      items: [
        "Added bring-your-own-key provider connections for OpenRouter, OpenAI, Groq, Anthropic, Google Gemini, OpenCode, Together AI, and Cerebras.",
        "Added credential validation, connection status, and provider preferences.",
        "Added model selection per run so users can choose the provider and model for each task.",
        "Added Cloudflare AI support for Workers AI and AI Gateway routes.",
      ],
    },
    {
      category: "platform",
      title: "Platform",
      items: [
        "Added private-alpha access gating for GitHub sign-in.",
        "Added a Cloud access request form backed by a waitlist database.",
        "Published the landing page, documentation, and changelog as static Cloudflare Pages applications.",
        "Added edge routing for the public `/agents/` and `/docs/` paths.",
      ],
    },
  ],
};

// Backfill through main d390186c (PR #481). Dates are main-branch merges
// in Asia/Kolkata. Development-only work and internal-only PRs are omitted.
export const changelogReleases: ChangelogRelease[] = [
  {
    id: "steer-queue-and-resume",
    title: "Steering, queued messages, and Play",
    date: "2026-10-17",
    sections: [
      {
        category: "product",
        title: "Improvements",
        items: [
          "Choose whether follow-ups steer the running task or wait in a queue, and set your send shortcut in composer settings.",
          "Queued messages stay saved after reload and start when the current task finishes. Stopping a task or encountering an error pauses the queue until you select Start.",
          "Messages show Unconfirmed when the app cannot verify that the agent received them.",
        ],
      },
    ],
    pullRequests: [481],
    highlights: [
      {
        category: "product",
        title: "Steering",
        description:
          "Send a follow-up while a task is running. The agent keeps the original request, attachments, and work so far.",
      },
      {
        category: "product",
        title: "Queued messages",
        description:
          "Line up follow-ups to run in order. Edit or remove them, or select Steer now to send one to the running task.",
      },
      {
        category: "product",
        title: "Resume after Stop",
        description:
          "Click Play to continue a stopped task with its saved file changes and conversation. Play is unavailable if those changes could not be saved.",
      },
    ],
  },
  {
    id: "approvals-pr-review-and-model-selection",
    title: "PR reviews and chat fixes",
    date: "2026-10-17",
    sections: [
      {
        category: "product",
        title: "Fixes",
        items: [
          "Fixed approval requests appearing only after switching chats.",
          "Denying an action lets the agent explain why it cannot proceed or continue with the access it has.",
          "Chats reconnect after temporary connection failures and offer Retry if the connection cannot recover.",
          "Fixed Stop leaving a chat waiting for approval after its workspace restarted.",
          "Fixed chats appearing to run when the task failed to start.",
          "The agent can read a PR's changed files and diffs, and continue reading results that are too large for one request.",
          "The agent gets an explanation when a command is rejected and can correct it once before the task fails.",
        ],
      },
      {
        category: "providers",
        title: "Providers",
        items: [
          "Fixed tool calls failing because OpenAI Responses treated optional arguments as required.",
        ],
      },
    ],
    pullRequests: [480],
    highlights: [
      {
        category: "product",
        title: "PR read access",
        description:
          "Approve PR reads for the current chat to review several PRs without approving each read. The permission covers reading PRs in the selected repository.",
      },
      {
        category: "providers",
        title: "Saved model selection",
        description:
          "Chats remember their provider and model when you switch chats, reload, or refresh the model list.",
      },
    ],
  },
  {
    id: "review-the-selected-saved-turn",
    title: "Review older changes",
    date: "2026-10-13",
    sections: [
      {
        category: "product",
        title: "Fixes",
        items: [
          "Fixed Review on an older message opening an empty sidebar or showing changes from the latest request.",
          "Reopening the same review keeps your selected file. Opening another message's review shows the changes made for that request.",
        ],
      },
    ],
    pullRequests: [475],
  },
  {
    id: "historical-commentary-without-extra-answers",
    title: "Removed extra replies in saved chats",
    date: "2026-10-13",
    sections: [
      {
        category: "product",
        title: "Fixes",
        items: [
          "Fixed saved commentary appearing as another answer below a completed reply.",
          "Progress messages stay in the expandable activity history. Replies from failed or stopped tasks remain visible.",
        ],
      },
    ],
    pullRequests: [474],
  },
  {
    id: "historical-final-answers-once",
    title: "Fixed duplicate final answers",
    date: "2026-10-12",
    sections: [
      {
        category: "product",
        title: "Fixes",
        items: [
          "Fixed final answers appearing twice when reopening older chats.",
          "Replies from failed or stopped tasks stay visible, along with any text that differs from the completed answer.",
        ],
      },
    ],
    pullRequests: [473],
  },
  {
    id: "durable-prompts-and-saved-history",
    title: "Saved chats and message retries",
    date: "2026-10-07",
    sections: [
      {
        category: "product",
        title: "Fixes",
        items: [
          "Fixed saved chats opening the setup screen before their history had loaded.",
          "Refreshing session or repository information no longer replaces an open chat with onboarding.",
          "Retrying a message after a delivery failure no longer starts a duplicate task.",
          "Partially loaded history stays visible instead of being treated as an empty chat.",
          "Assistant replies stay visible if the task fails or is stopped before finishing.",
        ],
      },
    ],
    pullRequests: [448],
  },
  {
    id: "images-survive-reload-and-compaction",
    title: "Images in follow-ups and long chats",
    date: "2026-10-02",
    sections: [
      {
        category: "product",
        title: "Improvements",
        items: [
          "Images are checked and resized before sending. The original uploaded files are kept, and invalid or oversized images show an error.",
          "Long chats keep the current request and tool results when older messages are summarized. Image usage appears separately from text estimates.",
        ],
      },
      {
        category: "providers",
        title: "Providers",
        items: [
          "Sending images with a model that has no confirmed image support now shows an error before the request is sent. This also checks images from earlier messages.",
        ],
      },
    ],
    pullRequests: [432],
    highlights: [
      {
        category: "product",
        title: "Keep earlier images",
        description:
          "Attached images remain available after reload and when older chat context is summarized. Text-only follow-ups can still refer to them.",
      },
    ],
  },
  {
    id: "clearer-workflow-and-permission-history",
    title: "Task status and permission history",
    date: "2026-10-02",
    sections: [
      {
        category: "product",
        title: "Improvements",
        items: [
          "Chat status shows when the agent is thinking, using tools, waiting for approval, or asking you a question. Requests that need your response appear first.",
          "Progress messages appear alongside the tool calls they describe. Tool calls no longer add repeated, generic progress text.",
          "Permission history shows whether you accepted or denied a request, or it was cancelled or expired.",
          "Other chats' status updates in the sidebar while you keep working in the current chat.",
        ],
      },
      {
        category: "providers",
        title: "Fixes",
        items: [
          "Fixed some OpenAI Responses tasks finishing without displaying a final answer.",
        ],
      },
    ],
    pullRequests: [443],
    highlights: [
      {
        category: "product",
        title: "Permission and question history",
        description:
          "Expand Requested permission or Asked questions to see the original request and your response, including after reload.",
      },
      {
        category: "product",
        title: "Allow actions for this chat",
        description:
          "Choose Always allow in this chat to approve future requests for the same action in the current workspace. Read-only mode and other access restrictions still apply.",
      },
    ],
  },
  {
    id: "find-chats-with-better-titles",
    title: "Automatic chat titles",
    date: "2026-10-02",
    sections: [
      {
        category: "product",
        title: "Improvements",
        items: [
          "Titles follow the language of your request and retain useful filenames, technical terms, and issue numbers.",
          "Generated titles appear while the task is running, without waiting for its response to finish.",
          "Fixed a delayed or cut-off generated title replacing an existing title.",
        ],
      },
    ],
    pullRequests: [444],
  },
  {
    id: "legioncode-identity-cutover",
    title: "The LegionCode rename",
    date: "2026-08-30",
    sections: [
      {
        category: "platform",
        title: "Changes",
        items: [
          "Renamed Shadowbox to LegionCode across the app, website, and documentation.",
          "You may need to sign in again and reapply browser preferences after the rename.",
        ],
      },
    ],
    pullRequests: [435, 431, 433],
  },
  {
    id: "responsive-provider-loading-and-task-status",
    title: "Model loading and task status",
    date: "2026-08-26",
    sections: [
      {
        category: "product",
        title: "Fixes",
        items: [
          "Fixed missing loading and sidebar status while a pending request reconnects.",
        ],
      },
      {
        category: "providers",
        title: "Providers",
        items: [
          "Fixed provider settings loading for the wrong task when switching chats.",
          "Fixed the model picker and Manage Models loading indefinitely after a failed request. They now show an unavailable message with Retry or Refresh.",
        ],
      },
    ],
    pullRequests: [429],
  },
  {
    id: "refreshed-public-site",
    title: "Updated Cloud website",
    date: "2026-08-20",
    sections: [
      {
        category: "platform",
        title: "Website",
        items: [
          "Updated the landing page with desktop and mobile product previews, the task workflow, and provider setup information.",
          "Increased mobile text sizes, made Request Access buttons consistent, and linked the footer to the documentation.",
        ],
      },
    ],
    pullRequests: [428],
  },
  {
    id: "independent-chat-settings-and-feedback",
    title: "Chat settings and approval fixes",
    date: "2026-08-16",
    sections: [
      {
        category: "product",
        title: "Fixes",
        items: [
          "Each saved chat keeps its provider and model when you switch tasks. New chats use separate defaults.",
          "Answering an approval in one chat no longer hides another chat's request.",
          "Fixed duplicate tool rows appearing when the app received the same update more than once.",
          "Review opens the right-sidebar Review tab, and generated titles stay in sync with saved chats.",
        ],
      },
      {
        category: "platform",
        title: "Removed",
        items: [
          "Removed language_diagnostics, which failed in minimal sandboxes. Agents can still run tests, type checks, and formatting commands.",
        ],
      },
    ],
    pullRequests: [427],
  },
  {
    id: "private-alpha-activation-and-parallel-tasks",
    title: "Setup and parallel tasks",
    date: "2026-08-15",
    sections: [
      {
        category: "product",
        title: "Improvements",
        items: [
          "Thinking and sidebar activity stay visible while the task runs. Consecutive tool calls are grouped together.",
          "Chat titles update sooner, and model details stay anchored to the picker.",
          "Older activity loads in pages so a long history does not leave the current chat loading.",
        ],
      },
      {
        category: "providers",
        title: "Providers",
        items: [
          "The agent's progress messages appear in chat without added narration for each tool call.",
          "Rate-limited requests show the provider's cooldown, then retry once.",
          "Removed sensitive internal details from provider and runtime error messages.",
        ],
      },
    ],
    pullRequests: [424, 425, 426],
    highlights: [
      {
        category: "product",
        title: "First-task setup",
        description:
          "Sign in with GitHub, select a repository, connect a provider, and start a task. Your choices carry through setup.",
      },
      {
        category: "product",
        title: "Three parallel tasks",
        description:
          "Run up to three tasks at once in separate workspaces. File contents are checked again before edits are applied.",
      },
    ],
  },
  {
    id: "image-attachments-in-the-composer",
    title: "Image attachments",
    date: "2026-08-12",
    sections: [
      {
        category: "product",
        title: "Added",
        items: [
          "Choose, paste, or drag images into the composer. Preview or remove them before sending, including in image-only requests.",
          "Images attached during setup carry over to the first saved chat and are sent to the selected provider.",
        ],
      },
    ],
    pullRequests: [423],
  },
  {
    id: "cloudflare-and-opencode-provider-routing",
    title: "Cloudflare and OpenCode connection fixes",
    date: "2026-08-12",
    sections: [
      {
        category: "providers",
        title: "Fixes",
        items: [
          "Fixed Cloudflare requests failing because they used outdated addresses or ignored saved gateway settings.",
          "Fixed OpenCode Zen and Go requests using the wrong API format for the selected model.",
          "Updated Cloudflare model loading and removed credentials from connection details sent to the browser.",
        ],
      },
    ],
    pullRequests: [422],
  },
  {
    id: "workspace-and-provider-settings-refresh",
    title: "Workspace and settings updates",
    date: "2026-08-12",
    sections: [
      {
        category: "product",
        title: "Improvements",
        items: [
          "Updated the sidebar with New chat, expandable Search, project folders, timestamps, and actions on hover.",
          "Adjusted conversation and review widths, anchored branch selection, and moved permission mode into the composer.",
          "Added search and project filters for archived chats.",
          "You can inspect the hooks used for each request from the assistant's actions and see their sources in Hooks settings.",
        ],
      },
      {
        category: "providers",
        title: "Providers",
        items: [
          "Updated provider settings with expandable model groups, readable model names, and consistent menus.",
        ],
      },
    ],
    pullRequests: [421],
  },
  {
    id: "live-progress-and-model-capabilities",
    title: "Task progress, context usage, and model controls",
    date: "2026-08-09",
    sections: [
      {
        category: "product",
        title: "Fixes",
        items: [
          "Submitted prompts and Starting or Working status stay visible during connection retries.",
          "Fixed duplicate final answers and approval prompts. Successful approval responses close the prompt; failed responses leave it available to retry.",
          "File activity distinguishes created files from modified ones.",
          "The context indicator shows token usage, reserved space, and cost with readable units.",
        ],
      },
      {
        category: "providers",
        title: "Providers",
        items: [
          "The thinking-level selector only shows levels supported by your model and clears saved choices that the model cannot use.",
          "Model details stop loading if models.dev does not respond and use previously saved details when available.",
        ],
      },
    ],
    pullRequests: [420],
  },
  {
    id: "leaner-sandbox-with-rust-support",
    title: "Rust compilation and sandbox size",
    date: "2026-08-02",
    sections: [
      {
        category: "platform",
        title: "Fixes",
        items: [
          "Restored Rust compilation by installing the missing linker.",
          "Reduced the sandbox image to fit Cloudflare's registry limit and added checks for image size and required tools.",
        ],
      },
    ],
    pullRequests: [418],
  },
  {
    id: "stable-runtime-and-review-workflow",
    title: "Task execution and saved diffs",
    date: "2026-08-02",
    sections: [
      {
        category: "product",
        title: "Improvements",
        items: [
          "Fixed follow-ups failing to start after Stop until you refreshed the browser.",
          "Concurrent chats keep separate messages, tools, approvals, and saved changes.",
          "Reopened chats show saved activity and whether each task completed, failed, or was interrupted.",
          "Read-tool rows open files in the sidebar with line numbers and a way to continue truncated reads.",
          "Generated titles update without refreshing. Fixed sign-out from the account menu.",
          "Fixed private model reasoning appearing in final answers and failed tool calls being reported as successful.",
        ],
      },
      {
        category: "providers",
        title: "Providers",
        items: [
          "The app opens without waiting for every provider's model list. Models load when you select a provider, with an unavailable message if loading fails.",
        ],
      },
      {
        category: "platform",
        title: "Fixes",
        items: [
          "Commands and Git actions are restricted to the current task's workspace. Errors explain whether a command timed out, was cancelled, or its workspace failed.",
          "Fixed review showing files from another task.",
        ],
      },
    ],
    pullRequests: [417, 415, 392, 394, 409, 410, 411, 416],
    highlights: [
      {
        category: "product",
        title: "Saved change review",
        description:
          "Review the changes a completed task made, even after more edits. Chat previews and the Review sidebar show the same saved diff.",
      },
      {
        category: "product",
        title: "Context and cost",
        description:
          "The composer shows context percentage, token usage, and spend. The Context tab shows the model, remaining space, and summary threshold when available.",
      },
    ],
  },
  {
    id: "authenticated-execution-and-capacity",
    title: "Task limits and access",
    date: "2026-07-25",
    sections: [
      {
        category: "platform",
        title: "Fixes",
        items: [
          "Starting a task now requires authentication and checks your request and concurrent-task limits before creating a workspace session.",
          "A task counts toward your concurrent-task limit until it finishes, fails, or is cancelled.",
        ],
      },
    ],
    pullRequests: [414],
  },
  {
    id: "workflow-history-that-matches-live-activity",
    title: "Workflow history after reload",
    date: "2026-06-30",
    sections: [
      {
        category: "product",
        title: "Fixes",
        items: [
          "Reopened chats show the same tool names, groups, order, and details you saw while the task ran.",
          "Earlier activity stays under its own request instead of appearing below a later reply.",
          "Fixed saved activity being replaced by repeated Thinking or tool-completed rows.",
        ],
      },
    ],
    pullRequests: [375, 371],
  },
  {
    id: "cloudflare-default-gateway-routing",
    title: "Default Cloudflare AI Gateway",
    date: "2026-06-30",
    sections: [
      {
        category: "providers",
        title: "Fixes",
        items: [
          "The gateway name is optional. Enter an account ID and token to use the default gateway.",
          "Fixed AI Gateway requests using the wrong API address and Workers AI model names.",
        ],
      },
    ],
    pullRequests: [374],
  },
  {
    id: "cloudflare-ai-provider-setup",
    title: "Cloudflare AI setup",
    date: "2026-06-29",
    sections: [
      {
        category: "providers",
        title: "Added",
        items: [
          "Connect a Cloudflare API token and account ID in provider settings, then choose Workers AI or AI Gateway.",
          "Saved account and gateway settings are used for model loading and task requests.",
        ],
      },
    ],
    pullRequests: [372],
  },
  {
    id: "follow-up-and-tool-failure-reliability",
    title: "Follow-up and tool failure fixes",
    date: "2026-06-27",
    sections: [
      {
        category: "product",
        title: "Fixes",
        items: [
          "Follow-up prompts reconnect to saved task activity without requiring a refresh or chat switch.",
          "Removed duplicate Thinking rows.",
          "Tool timeouts, cancellation, and execution failures no longer appear as successful results.",
          "Fixed final replies appearing saved when they would disappear after reload. A failed save now shows an error.",
        ],
      },
    ],
    pullRequests: [367],
  },
  launchRelease,
  ...developmentReleases,
];
