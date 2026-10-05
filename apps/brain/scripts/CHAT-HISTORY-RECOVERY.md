# Local chat history recovery

`recover-chat-history.mjs` inventories saved sessions, existing transcript
fingerprints, exact runtime identity tuples, lifecycle projection evidence,
local artifact references, and unresolved status rows. It reads Postgres from
the environment variable named by `--database-url-env` and scans copied
Miniflare roots read-only. It never emits message text or a database URL.

Keep database backups, restore evidence, identity audits, runtime roots, and
the generated manifest outside the repository. The manifest contains session
identifiers and content fingerprints, so the CLI writes it with mode `0600`.

Start with a dry-run. Each runtime root and decoded identity audit is explicit
and repeatable:

```sh
export LEGIONCODE_RECOVERY_DATABASE_URL='<local isolated restore URL>'
node apps/brain/scripts/recover-chat-history.mjs \
  --database-url-env LEGIONCODE_RECOVERY_DATABASE_URL \
  --runtime-root /private/path/to/main-runtime \
  --runtime-root /private/path/to/title-worktree-runtime \
  --identity-audit /private/path/to/identity-audit.json \
  --identity-audit /private/path/to/worktree-identity-audit.json \
  --artifact-root /private/path/to/main-runtime/v3/r2 \
  --artifact-root /private/path/to/title-worktree-runtime/v3/r2 \
  --manifest /private/path/to/private-recovery-manifest.json
```

Review conflict, unknown-workspace, projection, status, and artifact findings
before applying. Identity candidates count only when the exact tuple is found
in the copied SQLite `turnRuntimeIdentities` and `turnToRunMap` values, the
runtime run names the same session, the Postgres run and session have the same
owner and workspace, and the saved user message carries the tuple's client
message id. Null or conflicting workspace bindings stay unresolved. Legacy
sessions without a recoverable tuple receive one stable `thr_legacy_…` thread
binding with migration provenance; no historical turns or lifecycle events
are generated. A verified turn becomes the current revision target only when
its prompt is the newest user prompt across the whole session and its exact
thread/turn/attempt has terminal or active-run evidence. An older verified turn
is never selected when a newer prompt is unknown.
The scan includes user-message rows with no parts; a partless row or a tie for
the greatest prompt sequence makes the latest sequence unknown. Checkpoint
reapply verifies that the live `current_turn_id` equals the planned target and
that the checkpoint records that same target; an unexpected target fails
closed.

Applying requires the same dry-run manifest, a non-empty backup file, matching
backup SHA-256 restore evidence, the restored database fingerprint, and row
counts that agree with the isolated restore. Apply the same manifest again to
verify checkpoint idempotency:

Run inventory, freshness checking, apply, repeat apply, and verification only
against an isolated restored target. Keep one recovery process as its sole
writer for the entire operation: stop or disable the application, admin tools,
and any other recovery process that could write to that target. The CLI checks
freshness before its per-session transactions and does not enforce isolation
from concurrent writers. If exclusive access to the restored target cannot be
maintained, do not apply the manifest. Keep backups, restore evidence, identity
audits, and manifests private and outside the repository.

```sh
node apps/brain/scripts/recover-chat-history.mjs \
  --database-url-env LEGIONCODE_RECOVERY_DATABASE_URL \
  --runtime-root /private/path/to/main-runtime \
  --runtime-root /private/path/to/title-worktree-runtime \
  --identity-audit /private/path/to/identity-audit.json \
  --identity-audit /private/path/to/worktree-identity-audit.json \
  --artifact-root /private/path/to/main-runtime/v3/r2 \
  --artifact-root /private/path/to/title-worktree-runtime/v3/r2 \
  --manifest /private/path/to/private-recovery-manifest.json \
  --backup /private/path/to/pre-repair.dump \
  --restore-evidence /private/path/to/restore-evidence.json \
  --apply
```

The recovery transaction changes session thread bindings and imports only
verified admitted identity rows. Message and message-part IDs, text, ordering,
timestamps, and archive state are fingerprinted before and after each session
transaction. Ambiguous lifecycle-to-transcript matches are inventory findings;
the CLI does not append assistant text. Legacy status rows without attributable
terminal events remain unresolved. Local object bytes are checked when their
copied bucket blobs and metadata are available; remote provider migration stays
an explicit release gate.
