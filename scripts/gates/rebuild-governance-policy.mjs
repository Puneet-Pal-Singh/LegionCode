export const REBUILD_FLAG_REGISTRY = {
  FEATURE_FLAG_BYOK_V3_ENABLED: {
    owner: "apps/brain",
    temporary: true,
    deletionCriteria:
      "Delete with remaining BYOK v2/v3 transition controls after provider-neutral credential ownership is canonical.",
  },
  FEATURE_FLAG_BYOK_MIGRATION_ENABLED: {
    owner: "apps/brain",
    temporary: true,
    deletionCriteria:
      "Delete when provider credential state no longer uses background BYOK migration controls.",
  },
  FEATURE_FLAG_BYOK_MIGRATION_CUTOVER: {
    owner: "apps/brain",
    temporary: true,
    deletionCriteria:
      "Delete after the canonical provider credential path is the only supported path.",
  },
  FEATURE_FLAG_BYOK_RATE_LIMIT_ENABLED: {
    owner: "apps/brain",
    temporary: false,
    deletionCriteria: "",
  },
  FEATURE_FLAG_CHAT_EVENT_STREAM_V1: {
    owner: "apps/brain",
    temporary: true,
    deletionCriteria:
      "Delete when event-stream chat transport is the canonical Brain-to-Web response path.",
  },
  FEATURE_FLAG_CHAT_AGENTIC_LOOP_V1: {
    owner: "apps/brain",
    temporary: true,
    deletionCriteria:
      "Delete after the agentic loop is the canonical run-execution policy.",
  },
  FEATURE_FLAG_CHAT_REVIEWER_PASS_V1: {
    owner: "apps/brain",
    temporary: true,
    deletionCriteria:
      "Delete when reviewer pass behavior is canonical or replaced by contract-tested runtime policy.",
  },
  FEATURE_FLAG_CLOUDFLARE_AGENTS_V1: {
    owner: "apps/brain",
    temporary: true,
    deletionCriteria:
      "Delete when Cloudflare Agents orchestration is either canonical or intentionally removed.",
  },
  FEATURE_FLAG_GH_CLI_LANE_ENABLED: {
    owner: "apps/brain",
    temporary: true,
    deletionCriteria:
      "Delete when the GitHub CLI lane is canonical and covered by tool-floor conformance.",
  },
  FEATURE_FLAG_GH_CLI_CI_ENABLED: {
    owner: "apps/brain",
    temporary: true,
    deletionCriteria:
      "Delete when GitHub CI read flows are canonical or replaced by one GitHub authority.",
  },
  FEATURE_FLAG_GH_CLI_PR_COMMENT_ENABLED: {
    owner: "apps/brain",
    temporary: true,
    deletionCriteria:
      "Delete when PR comment mutation has one canonical GitHub authority.",
  },
  FEATURE_FLAG_FINAL_SUMMARY_CONTRACT_V1: {
    owner: "packages/execution-engine",
    temporary: true,
    deletionCriteria:
      "Delete when final visible outcome framing is mandatory for all runtime terminal states.",
  },
};

export const GENERAL_PR_METADATA_FIELDS = [
  "merge independence",
  "remaining integration",
  "temporary mechanism deletion criteria",
];

export const LIFECYCLE_METADATA_FIELDS = [
  "user-visible symptom",
  "full affected lifecycle",
  "canonical owner",
  "violated invariant",
  "architectural root cause",
  "duplicate authority or fallback removed",
  "boundary regression test",
  "lifecycle/conformance regression test",
];

export const LIFECYCLE_SENSITIVE_PATHS = [
  /^apps\/brain\/src\/application\/chat\//,
  /^apps\/brain\/src\/controllers\/ChatController/,
  /^apps\/brain\/src\/controllers\/chat-runtime-helpers/,
  /^apps\/brain\/src\/services\/runtime-events\//,
  /^apps\/secure-agent-api\//,
  /^apps\/web\/src\/components\/chat\//,
  /^apps\/web\/src\/components\/git\//,
  /^apps\/web\/src\/hooks\/useChat/,
  /^apps\/web\/src\/hooks\/useRun/,
  /^apps\/web\/src\/services\/activity\//,
  /^apps\/web\/src\/services\/run/,
  /^packages\/event-store\//,
  /^packages\/execution-engine\/src\/runtime\//,
  /^packages\/git-service\//,
  /^packages\/persistence\/src\/canonical-events\//,
  /^packages\/persistence\/src\/runtime-events\//,
  /^packages\/platform-protocol\/src\/events/,
  /^packages\/runtime-kernel\//,
  /^packages\/worker-protocol\//,
];

export const MIGRATION_SENSITIVE_PATHS = [
  /^packages\/persistence\/src\/migrations\//,
  /^packages\/persistence\/src\/schema\//,
  /^packages\/persistence\/src\/canonical-events\//,
  /^packages\/persistence\/src\/runtime-events\//,
  /^packages\/persistence\/src\/.*migration\.test\.ts$/,
];
