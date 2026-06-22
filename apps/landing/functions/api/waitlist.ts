import {
  handleWaitlistRequest,
  type WaitlistEntry,
} from "../_shared/waitlist";

interface WaitlistStatement {
  bind(...values: Array<string | number | null>): WaitlistStatement;
  run(): Promise<unknown>;
}

interface WaitlistDatabase {
  prepare(query: string): WaitlistStatement;
}

interface WaitlistBindings {
  WAITLIST_DB: WaitlistDatabase;
}

export const onRequestPost = async (context: {
  request: Request;
  env: WaitlistBindings;
}): Promise<Response> => {
  try {
    return await handleWaitlistRequest(context.request, {
      save: (entry) => saveWaitlistEntry(context.env.WAITLIST_DB, entry),
    });
  } catch (error) {
    console.error("[waitlist/create] Failed to record access request.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: "We could not record your request. Please try again." },
      { status: 503 },
    );
  }
};

async function saveWaitlistEntry(
  database: WaitlistDatabase,
  entry: WaitlistEntry,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO waitlist_entries (id, email, source, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT(email) DO UPDATE SET
         source = excluded.source,
         updated_at = excluded.updated_at`,
    )
    .bind(entry.id, entry.email, entry.source, entry.createdAt)
    .run();
}
