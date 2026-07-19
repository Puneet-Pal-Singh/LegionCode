import {
  ThreadTitleSourceSchema,
} from "@repo/platform-protocol";
import { buildSqlList } from "../sessions/types.js";
import type { SqlMigration } from "./types.js";

const THREAD_TITLE_SOURCE_SQL_LIST = buildSqlList(
  ThreadTitleSourceSchema.options,
);

export const threadTitlePreviewSourceMigration: SqlMigration = {
  id: "0027_thread_title_preview_source",
  description:
    "Allow deterministic preview titles in canonical thread projections",
  statements: [
    `ALTER TABLE canonical_thread_projections DROP CONSTRAINT IF EXISTS canonical_thread_projections_title_source_check`,
    `ALTER TABLE canonical_thread_projections ADD CONSTRAINT canonical_thread_projections_title_source_check CHECK (title_source IN (${THREAD_TITLE_SOURCE_SQL_LIST}))`,
  ],
};
