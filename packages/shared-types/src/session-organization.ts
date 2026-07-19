export const CHAT_TITLE_SOURCES = ["preview", "generated", "user"] as const;

export type ChatTitleSource = (typeof CHAT_TITLE_SOURCES)[number];

export interface SessionOrganizationMetadata {
  title: string;
  titleSource: ChatTitleSource;
  pinnedAt: string | null;
  archivedAt: string | null;
}
