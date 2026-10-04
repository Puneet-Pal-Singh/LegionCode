#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recoveryCheckpointCurrentTurnMatches, recoveryProofShape, resolveLatestUserPromptSequence, selectRecoverableCurrentTurn } from "./recovery-current-turn.mjs";

const MANIFEST_VERSION = 2;
const MIGRATION_ID = "chat_history_recovery_v1";
const requireFromPersistence = createRequire(
  new URL("../../../packages/persistence/package.json", import.meta.url),
);
const { Pool } = requireFromPersistence("pg");

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unexpected failure";
  console.error(`[chat-recovery] ${message}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const connectionString = process.env[options.databaseUrlEnv];
  if (!connectionString) {
    throw new Error(`Database URL environment variable ${options.databaseUrlEnv} is unset`);
  }
  const pool = new Pool({ connectionString, max: 1, application_name: "legioncode-chat-recovery" });
  try {
    const roots = await inventoryRoots(options.runtimeRoots);
    const candidates = loadIdentityCandidates(options.identityAudits, roots);
    const plan = await buildPlan(pool, candidates, roots, options.artifactRoots ?? []);
    let manifest = {
      kind: "legioncode.chat-history-recovery",
      version: MANIFEST_VERSION,
      migrationId: MIGRATION_ID,
      mode: options.apply ? "apply" : "dry-run",
      generatedAt: new Date().toISOString(),
      databaseFingerprint: databaseFingerprint(connectionString),
      roots,
      identityAuditFingerprints: options.identityAudits.map((file) => ({
        path: path.resolve(file),
        sha256: sha256(readFileSync(file)),
      })),
      ...plan,
    };
    const manifestHash = sha256(Buffer.from(stableJson(manifest)));
    manifest.manifestHash = manifestHash;

    if (options.apply) {
      await verifyApplyEvidence(options, connectionString, manifest);
      if (!options.manifestPath) throw new Error("--apply requires --manifest PATH");
      const priorManifest = readPrivateManifest(options.manifestPath);
      const priorHash = priorManifest.manifestHash;
      const priorWithoutHash = { ...priorManifest };
      delete priorWithoutHash.manifestHash;
      if (priorManifest.version !== MANIFEST_VERSION || priorManifest.mode !== "dry-run" || priorHash !== sha256(Buffer.from(stableJson(priorWithoutHash)))) {
        throw new Error(`--manifest must reference an intact version ${MANIFEST_VERSION} dry-run inventory`);
      }
      assertManifestFresh(priorManifest, manifest);
      await applyPlan(pool, priorManifest, priorHash);
      const postApply = await verifyPostApply(pool, priorManifest.sessions);
      report({ ...priorManifest, mode: "applied", postApply });
      return;
    }

    if (options.manifestPath) await writePrivateManifest(options.manifestPath, manifest);
    report(manifest);
  } finally {
    await pool.end();
  }
}

function parseArgs(args) {
  const result = {
    databaseUrlEnv: "DATABASE_URL",
    runtimeRoots: [],
    identityAudits: [],
    apply: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--apply") result.apply = true;
    else if (["--database-url-env", "--runtime-root", "--identity-audit", "--manifest", "--backup", "--restore-evidence", "--artifact-root"].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--database-url-env") result.databaseUrlEnv = value;
      if (arg === "--runtime-root") result.runtimeRoots.push(value);
      if (arg === "--identity-audit") result.identityAudits.push(value);
      if (arg === "--manifest") result.manifestPath = value;
      if (arg === "--backup") result.backupPath = value;
      if (arg === "--restore-evidence") result.restoreEvidencePath = value;
      if (arg === "--artifact-root") result.artifactRoots ??= [], result.artifactRoots.push(value);
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result.databaseUrlEnv)) {
    throw new Error("--database-url-env must name an environment variable");
  }
  if (result.apply && (!result.backupPath || !result.restoreEvidencePath)) {
    throw new Error("--apply requires --backup and --restore-evidence");
  }
  return result;
}

function printHelp() {
  console.log(`Usage: node apps/brain/scripts/recover-chat-history.mjs [options]

Dry-run is the default. The database URL is read only from the named environment variable.

  --database-url-env NAME  Environment variable containing the Postgres URL
  --runtime-root PATH      Read-only copied Miniflare root; repeatable
  --identity-audit PATH    Decoded runtime identity JSON array; repeatable
  --artifact-root PATH     Read-only copied R2 root; repeatable
  --manifest PATH          Write a mode-0600 versioned private manifest
  --apply                  Apply the manifest plan (requires backup evidence)
  --backup PATH            Verified database dump file
  --restore-evidence PATH  JSON evidence of successful isolated restore
  --help                   Show this help
`);
}

async function inventoryRoots(rootPaths) {
  const roots = [];
  for (const suppliedPath of rootPaths) {
    const absolute = path.resolve(suppliedPath);
    const resolved = realpathSync(absolute);
    const files = [];
    walkReadOnly(resolved, files);
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    roots.push({ path: resolved, fileCount: files.length, files, fingerprint: sha256(Buffer.from(stableJson(files))) });
  }
  return roots;
}

function walkReadOnly(root, files, current = root) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walkReadOnly(root, files, fullPath);
    else if (stat.isFile()) {
      const content = readFileSync(fullPath);
      files.push({ relativePath: path.relative(root, fullPath), length: stat.size, sha256: sha256(content) });
    }
  }
}

function loadIdentityCandidates(auditPaths, roots) {
  const result = [];
  const cache = new Map();
  for (const auditPath of auditPaths) {
    const parsed = JSON.parse(readFileSync(auditPath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`Identity audit must be a JSON array: ${auditPath}`);
    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      const provenance = ["namespace", "file"];
      const identityFields = ["sessionId", "workspaceId", "runId", "threadId", "turnId", "runAttemptId"];
      if ([...provenance, ...identityFields].some((key) => typeof entry[key] !== "string" || !entry[key])) continue;
      const sourcePath = findRuntimeFile(roots, entry.namespace, entry.file);
      if (!sourcePath) continue;
      const cacheKey = `${sourcePath}\u0000${entry.runId}`;
      let decoded = cache.get(cacheKey);
      if (!decoded) {
        try { decoded = decodeRuntimeIdentity(sourcePath, entry.runId); }
        catch { cache.set(cacheKey, null); continue; }
      }
      cache.set(cacheKey, decoded);
      const identity = decoded.turnRuntimeIdentities?.[entry.turnId];
      if (!identity || decoded.turnToRunMap?.[entry.turnId] !== entry.runId) continue;
      if (identityFields.some((key) => identity[key] !== entry[key])) continue;
      if (decoded.run?.sessionId !== entry.sessionId) continue;
      result.push({
        ...Object.fromEntries(identityFields.map((key) => [key, entry[key]])),
        revisionOfTurnId: identity.revisionOfTurnId ?? null,
        ownerUserId: identity.ownerUserId ?? null,
        sourceNamespace: entry.namespace,
        sourceFile: entry.file,
        sourceAudit: path.resolve(auditPath),
      });
    }
  }
  return result;
}

async function buildPlan(pool, candidates, roots, artifactRoots) {
  const sessions = await pool.query(`
    SELECT s.id::text AS session_id, s.user_id::text AS user_id,
           s.workspace_id::text AS workspace_id, t.workspace_id::text AS task_workspace_id,
           (t.user_id = s.user_id) AS task_owner_matches,
           s.thread_id, s.thread_binding_source, s.thread_binding_migration_id,
           s.active_run_id, s.current_turn_id, s.archived_at,
           (SELECT count(*)::int FROM messages m WHERE m.session_id = s.id) AS message_count,
           (SELECT count(*)::int FROM message_parts p WHERE p.session_id = s.id) AS part_count,
           (SELECT count(*)::int FROM artifacts a WHERE a.session_id = s.id) AS artifact_count
      FROM sessions s JOIN tasks t ON t.id = s.task_id
     ORDER BY s.id`);
  const inventory = [];
  const sourceCounts = await pool.query(`
    SELECT (SELECT count(*)::int FROM sessions) AS sessions,
           (SELECT count(*)::int FROM messages) AS messages,
           (SELECT count(*)::int FROM message_parts) AS message_parts,
           (SELECT count(*)::int FROM canonical_lifecycle_events) AS lifecycle_events`);
  const verifiedCandidates = [];
  for (const session of sessions.rows) {
    const data = await sessionContent(pool, session.session_id);
    const promptRows = await pool.query(`
      SELECT m.id::text, min(p.session_sequence)::text AS prompt_sequence,
             count(p.id)::int AS part_count
        FROM messages m LEFT JOIN message_parts p
          ON p.message_id = m.id AND p.session_id = m.session_id
       WHERE m.session_id = $1 AND m.role = 'user'
       GROUP BY m.id`, [session.session_id]);
    const latestPrompt = resolveLatestUserPromptSequence(promptRows.rows);
    const latestUserPromptSequence = latestPrompt.sequence;
    const sessionCandidates = candidates.filter((candidate) => candidate.sessionId === session.session_id);
    const evidence = await validateCandidates(pool, session, sessionCandidates, latestUserPromptSequence);
    verifiedCandidates.push(...evidence.verified);
    const distinctThreads = [...new Set(evidence.verified.map((candidate) => candidate.threadId))];
    const conflicts = [...evidence.conflicts];
    if (distinctThreads.length > 1) conflicts.push("runtime sources disagree on thread identity");
    const tuplesByTurn = new Map();
    for (const candidate of evidence.verified) {
      const tuple = [candidate.threadId, candidate.runAttemptId, candidate.runId, candidate.workspaceId, candidate.revisionOfTurnId ?? null];
      const prior = tuplesByTurn.get(candidate.turnId);
      if (prior && stableJson(prior) !== stableJson(tuple)) conflicts.push(`runtime sources disagree on turn identity ${shortId(candidate.turnId)}`);
      tuplesByTurn.set(candidate.turnId, tuple);
    }
    if (session.thread_id && distinctThreads.some((id) => id !== session.thread_id)) conflicts.push("persisted session thread conflicts with runtime identity");
    const exactThread = distinctThreads.length === 1 && conflicts.length === 0 ? distinctThreads[0] : null;
    const threadId = session.thread_id ?? exactThread ?? stableLegacyThread(session.session_id);
    const bindingSource = session.thread_id
      ? session.thread_binding_source ?? "existing"
      : exactThread
        ? "runtime_admission"
        : "legacy_recovery";
    const exactAdmissions = conflicts.length === 0 ? evidence.verified : [];
    inventory.push({
      sessionId: session.session_id,
      ownerId: session.user_id,
      workspaceId: session.workspace_id,
      taskOwnerMatches: session.task_owner_matches,
      existingThreadId: session.thread_id,
      threadId,
      threadBindingSource: bindingSource,
      messageCount: session.message_count,
      partCount: session.part_count,
      artifactCount: session.artifact_count,
      archivedAt: session.archived_at ? new Date(session.archived_at).toISOString() : null,
      activeRunId: session.active_run_id,
      existingCurrentTurnId: session.current_turn_id,
      contentFingerprint: data.fingerprint,
      latestUserPromptSequence,
      identityCandidates: sessionCandidates.length,
      verifiedExactTuples: exactAdmissions.length,
      unverifiableIdentityCandidates: Math.max(0, sessionCandidates.length - exactAdmissions.length - evidence.conflicts.length),
      importedAdmissions: exactAdmissions,
      recoveredCurrentTurnId: selectRecoverableCurrentTurn(exactAdmissions, latestUserPromptSequence)?.turnId ?? null,
      latestPromptUncertain: latestPrompt.uncertain,
      conflicts,
      status: conflicts.length ? "conflict" : session.thread_id ? "already_bound" : exactThread ? "exact_runtime_identity" : "legacy_binding",
    });
  }
  const sessionsByThread = new Map();
  const admissionsByGlobalId = new Map();
  for (const session of inventory) {
    const threadSessions = sessionsByThread.get(session.threadId) ?? [];
    threadSessions.push(session);
    sessionsByThread.set(session.threadId, threadSessions);
    for (const admission of session.importedAdmissions) {
      for (const [kind, id] of [["turn", admission.turnId], ["run attempt", admission.runAttemptId]]) {
        const key = `${kind}:${id}`;
        const previous = admissionsByGlobalId.get(key);
        if (previous && previous.sessionId !== session.sessionId) {
          previous.conflicts.push(`global ${kind} identity is also claimed by session ${shortId(session.sessionId)}`);
          session.conflicts.push(`global ${kind} identity conflicts with session ${shortId(previous.sessionId)}`);
        } else admissionsByGlobalId.set(key, session);
      }
    }
  }
  for (const [threadId, owners] of sessionsByThread) {
    const distinctSessionIds = new Set(owners.map((session) => session.sessionId));
    if (distinctSessionIds.size < 2) continue;
    for (const session of owners) session.conflicts.push(`thread ${shortId(threadId)} is bound or planned for more than one session`);
  }
  const artifacts = await inventoryArtifacts(pool, artifactRoots);
  const assistantProjectionInventory = await inventoryAssistantProjectionGaps(pool, verifiedCandidates);
  const statusInventory = await inventoryLegacyStatus(pool);
  const repairsBySession = new Map();
  for (const group of assistantProjectionInventory.groups) {
    if (group.repair !== "attach_exact_event_projection_identity") continue;
    const repairs = repairsBySession.get(group.sessionId) ?? [];
    repairs.push(group);
    repairsBySession.set(group.sessionId, repairs);
  }
  for (const session of inventory) session.projectionRepairs = repairsBySession.get(session.sessionId) ?? [];
  return {
    sessionCount: inventory.length,
    sourceCounts: {
      sessions: sourceCounts.rows[0].sessions,
      messages: sourceCounts.rows[0].messages,
      messageParts: sourceCounts.rows[0].message_parts,
      lifecycleEvents: sourceCounts.rows[0].lifecycle_events,
    },
    conflictCount: inventory.filter((session) => session.conflicts.length > 0).length,
    eligibleSessionCount: inventory.filter((session) => session.conflicts.length === 0).length,
    externalProviderMigration: "unverified: production and remote object stores were not inspected by this local recovery tool",
    assistantProjectionInventory,
    legacyStatusInventory: statusInventory,
    artifactInventory: artifacts,
    sessions: inventory,
  };
}

async function sessionContent(pool, sessionId) {
  const result = await pool.query(`
    SELECT m.id::text AS message_id, m.role, m.run_id, m.client_message_id,
           m.dedupe_key, m.created_at,
           p.id::text AS part_id, p.part_type, p.session_sequence,
           p.content_json, p.created_at AS part_created_at
      FROM messages m
      LEFT JOIN message_parts p ON p.message_id = m.id AND p.session_id = m.session_id
     WHERE m.session_id = $1
     ORDER BY m.created_at, m.id, p.session_sequence, p.id`, [sessionId]);
  const records = result.rows.map((row) => ({
    messageId: row.message_id,
    role: row.role,
    runId: row.run_id,
    clientMessageId: row.client_message_id,
    dedupeKey: row.dedupe_key,
    messageCreatedAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    partId: row.part_id,
    partType: row.part_type,
    sequence: row.session_sequence == null ? null : String(row.session_sequence),
    content: row.content_json,
    partCreatedAt: row.part_created_at instanceof Date ? row.part_created_at.toISOString() : row.part_created_at,
  }));
  return { fingerprint: sha256(Buffer.from(stableJson(records))), records };
}

async function validateCandidates(pool, session, candidates, latestUserPromptSequence) {
  const verified = [];
  const conflicts = [];
  const grouped = new Map();
  for (const candidate of candidates) {
    const clientMessageId = candidate.turnId.match(/__turn__(client_msg_.+)$/)?.[1];
    if (!clientMessageId) continue;
    const identityKey = [candidate.threadId, candidate.turnId, candidate.runAttemptId, candidate.runId, clientMessageId].join("\u0000");
    grouped.set(identityKey, { ...candidate, clientMessageId });
  }
  for (const candidate of grouped.values()) {
    const result = await pool.query(`
      SELECT r.id, r.session_id::text AS session_id, r.user_id::text AS user_id,
             r.workspace_id::text AS workspace_id, r.status AS run_status,
             EXISTS (SELECT 1 FROM canonical_lifecycle_events e
                       WHERE e.turn_id = $3 AND e.run_attempt_id = $4 AND e.thread_id = $5
                         AND e.event_type IN ('turn.completed','turn.failed','turn.interrupted','turn.cancelled','turn.timed_out')) AS has_canonical_terminal,
             EXISTS (SELECT 1 FROM messages m WHERE m.session_id = r.session_id
                       AND m.run_id = r.id AND m.role = 'user' AND m.client_message_id = $2) AS has_prompt
        FROM runs r WHERE r.id = $1`, [candidate.runId, candidate.clientMessageId, candidate.turnId, candidate.runAttemptId, candidate.threadId]);
    const run = result.rows[0];
    if (!run || !session.task_owner_matches || run.session_id !== session.session_id || run.user_id !== session.user_id || (candidate.ownerUserId && candidate.ownerUserId !== run.user_id)) {
      conflicts.push(`candidate ${shortId(candidate.turnId)} failed session/run owner/workspace match`);
      continue;
    }
    if (session.workspace_id !== candidate.workspaceId || (run.workspace_id && run.workspace_id !== candidate.workspaceId)) {
      const knownWorkspace = run.workspace_id ?? session.workspace_id ?? session.task_workspace_id;
      if (knownWorkspace && knownWorkspace !== candidate.workspaceId) {
        conflicts.push(`candidate ${shortId(candidate.turnId)} has a conflicting workspace binding`);
      }
      continue;
    }
    if (!run.has_prompt) continue;
    const prompt = await pool.query(`
      SELECT min(p.session_sequence)::text AS prompt_sequence
        FROM messages m JOIN message_parts p ON p.message_id = m.id AND p.session_id = m.session_id
       WHERE m.session_id = $1 AND m.run_id = $2 AND m.role = 'user' AND m.client_message_id = $3`,
    [session.session_id, candidate.runId, candidate.clientMessageId]);
    const promptSequence = prompt.rows[0]?.prompt_sequence ?? null;
    if (promptSequence == null) continue;
    verified.push({
      ...candidate,
      promptSequence,
      executionState: run.has_canonical_terminal ? "settled" : "recovery_required",
      isProvenCurrentTurn: promptSequence === latestUserPromptSequence && (run.has_canonical_terminal || (session.active_run_id === candidate.runId && run.run_status === "running")),
    });
  }
  return { verified, conflicts };
}

async function inventoryArtifacts(pool, artifactRoots) {
  const result = await pool.query(`
    SELECT id::text, session_id::text, run_id, r2_object_key,
           size_bytes, sha256, content_type, storage_backend, status
      FROM artifacts ORDER BY session_id, id`);
  const objects = await readBucketObjectIndexes(artifactRoots);
  const durableMetadata = await pool.query(`
    SELECT artifact_id, thread_id, run_id, workspace_id, artifact_kind,
           payload_backend, payload_object_key, content_type, size_bytes, sha256,
           source_event_id
      FROM artifact_metadata ORDER BY artifact_id`);
  const mediaRows = await pool.query(`
    SELECT id::text, session_id::text, run_id, media_artifacts_json
      FROM context_snapshots
     WHERE media_artifacts_json IS NOT NULL
     ORDER BY id`);
  const references = result.rows.map((row) => {
    const matches = objects.filter((object) => object.key === row.r2_object_key);
    const object = matches.length === 1 ? matches[0] : null;
    const lengthMatches = Boolean(object && row.size_bytes != null && Number(object.size) === Number(row.size_bytes));
    const metadataDigestMatches = Boolean(object && row.sha256 && object.customMetadata?.patchSha256 && row.sha256.toLowerCase() === object.customMetadata.patchSha256.toLowerCase());
    const digestMatches = Boolean(object && row.sha256 && object.blobSha256 && row.sha256.toLowerCase() === object.blobSha256.toLowerCase() && metadataDigestMatches);
    return {
      artifactId: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      objectKey: row.r2_object_key,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      contentType: row.content_type,
      storageBackend: row.storage_backend,
      status: row.status,
      bucketObjectCopies: matches.length,
      localLengthMatches: lengthMatches,
      localDigestMatches: digestMatches,
      verification: lengthMatches && digestMatches ? "verified_local_bucket_bytes" : "unverified",
    };
  });
  const metadataReferences = durableMetadata.rows.map((row) => {
    const matches = objects.filter((object) => object.key === row.payload_object_key);
    const object = matches.length === 1 ? matches[0] : null;
    const lengthMatches = Boolean(object && Number(object.size) === Number(row.size_bytes));
    const digestMatches = Boolean(object && object.blobSha256 && object.blobSha256 === row.sha256);
    return { artifactId: row.artifact_id, runId: row.run_id, workspaceId: row.workspace_id, artifactKind: row.artifact_kind, objectKey: row.payload_object_key, contentType: row.content_type, sizeBytes: Number(row.size_bytes), sha256: row.sha256, sourceEventId: row.source_event_id, bucketObjectCopies: matches.length, localLengthMatches: lengthMatches, localDigestMatches: digestMatches, verification: lengthMatches && digestMatches ? "verified_local_bucket_bytes" : "unverified" };
  });
  const mediaReferences = mediaRows.rows.flatMap((row) => {
    const references = collectMediaReferences(row.media_artifacts_json);
    return references.map((reference, index) => {
      const matches = reference.objectKey ? objects.filter((object) => object.key === reference.objectKey) : [];
      const object = matches.length === 1 ? matches[0] : null;
      const lengthMatches = Boolean(object && reference.sizeBytes != null && Number(object.size) === Number(reference.sizeBytes));
      const digestMatches = Boolean(object && reference.sha256 && object.blobSha256 && reference.sha256.toLowerCase() === object.blobSha256.toLowerCase());
      return { contextSnapshotId: row.id, sessionId: row.session_id, runId: row.run_id, referenceIndex: index, referenceFingerprint: sha256(Buffer.from(stableJson(reference))), objectKey: reference.objectKey ?? null, sizeBytes: reference.sizeBytes ?? null, sha256: reference.sha256 ?? null, bucketObjectCopies: matches.length, localLengthMatches: lengthMatches, localDigestMatches: digestMatches, verification: lengthMatches && digestMatches ? "verified_local_media_bytes" : "unverified" };
    });
  });
  return {
    referenceCount: result.rowCount,
    localBucketObjectCount: objects.length,
    verifiedLocalReferences: references.filter((artifact) => artifact.verification === "verified_local_bucket_bytes").length,
    references,
    metadataReferenceCount: metadataReferences.length,
    verifiedMetadataReferences: metadataReferences.filter((artifact) => artifact.verification === "verified_local_bucket_bytes").length,
    metadataReferences,
    mediaReferenceCount: mediaReferences.length,
    verifiedMediaReferences: mediaReferences.filter((reference) => reference.verification === "verified_local_media_bytes").length,
    mediaReferences,
  };
}

function collectMediaReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const child of value) collectMediaReferences(child, references);
    return references;
  }
  if (!isRecord(value)) return references;
  const objectKey = value.objectKey ?? value.r2ObjectKey ?? value.payloadObjectKey ?? value.key;
  const digest = value.sha256 ?? value.digest;
  const size = value.sizeBytes ?? value.size;
  if (typeof objectKey === "string" || (typeof digest === "string" && typeof size === "number")) {
    references.push({
      objectKey: typeof objectKey === "string" ? objectKey : undefined,
      sha256: typeof digest === "string" ? digest : undefined,
      sizeBytes: typeof size === "number" ? size : undefined,
    });
  }
  for (const [key, child] of Object.entries(value)) {
    if (["objectKey", "r2ObjectKey", "payloadObjectKey", "key", "sha256", "digest", "sizeBytes", "size"].includes(key)) continue;
    collectMediaReferences(child, references);
  }
  return references;
}

function findRuntimeFile(roots, namespace, fileName) {
  for (const root of roots) {
    const suffix = path.join("do", namespace, fileName);
    const match = root.files.find((file) => file.relativePath.endsWith(suffix));
    if (match) return path.join(root.path, match.relativePath);
  }
  return null;
}

function decodeRuntimeIdentity(sqlitePath, runId) {
  const python = [
    "import base64, json, sqlite3, sys",
    "db = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)",
    "def value(key):",
    "    row = db.execute('SELECT value FROM _cf_KV WHERE key = ?', (key,)).fetchone()",
    "    return base64.b64encode(row[0]).decode('ascii') if row else None",
    "print(json.dumps({'identities': value('turnRuntimeIdentities'), 'turns': value('turnToRunMap'), 'run': value('run:' + sys.argv[2])}))",
  ].join("\n");
  const raw = JSON.parse(execFileSync("python3", ["-c", python, sqlitePath, runId], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const deserialize = requireFromPersistence("node:v8").deserialize;
  const decode = (value) => value ? deserialize(Buffer.from(value, "base64")) : {};
  return { turnRuntimeIdentities: decode(raw.identities), turnToRunMap: decode(raw.turns), run: raw.run ? decode(raw.run) : null };
}

async function readBucketObjectIndexes(roots) {
  const objects = [];
  const python = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)",
    "try: rows = db.execute('SELECT key, blob_id, size, custom_metadata FROM _mf_objects').fetchall()",
    "except sqlite3.Error: rows = []",
    "print(json.dumps([{'key': key, 'blobId': blob_id, 'size': size, 'customMetadata': metadata} for key, blob_id, size, metadata in rows]))",
  ].join("\n");
  for (const suppliedRoot of roots) {
    const root = realpathSync(suppliedRoot);
    const files = [];
    walkReadOnly(root, files);
    const blobFiles = new Map(files.map((file) => [path.basename(file.relativePath), file]));
    for (const file of files.filter((entry) => entry.relativePath.endsWith(".sqlite"))) {
      const sqlitePath = path.join(root, file.relativePath);
      let rows;
      try { rows = JSON.parse(execFileSync("python3", ["-c", python, sqlitePath], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
      catch { continue; }
      for (const row of rows) {
        let metadata = {};
        try { metadata = JSON.parse(row.customMetadata ?? "{}"); } catch {}
        const blob = row.blobId ? blobFiles.get(row.blobId) : null;
        objects.push({ key: row.key, size: row.size, blobSha256: blob?.sha256 ?? null, customMetadata: metadata });
      }
    }
  }
  return objects;
}

async function inventoryAssistantProjectionGaps(pool, candidates) {
  const candidateByTurn = new Map(candidates.map((candidate) => [candidate.turnId, candidate]));
  const groups = new Map();
  const eventRows = await pool.query(`
    SELECT event_id, turn_id, run_attempt_id, event_json
      FROM canonical_lifecycle_events
     WHERE event_type = 'assistant_message.delta'
     ORDER BY turn_id, sequence`);
  let unmatchedEventCount = 0;
  for (const row of eventRows.rows) {
    const candidate = candidateByTurn.get(row.turn_id);
    if (!candidate) { unmatchedEventCount += 1; continue; }
    const event = row.event_json;
    const phase = event?.payload?.phase;
    const itemId = event?.itemId;
    const delta = event?.payload?.delta;
    // Lifecycle storage carries turn and attempt linkage in indexed columns;
    // the serialized event envelope does not repeat run/session identity.
    if ((event?.eventId && event.eventId !== row.event_id) || row.run_attempt_id !== candidate.runAttemptId) { unmatchedEventCount += 1; continue; }
    if (typeof phase !== "string" || typeof itemId !== "string" || typeof delta !== "string") { unmatchedEventCount += 1; continue; }
    const key = [row.turn_id, row.run_attempt_id, itemId, phase].join("\u0000");
    const group = groups.get(key) ?? { turnId: row.turn_id, runAttemptId: row.run_attempt_id, runId: candidate.runId, sessionId: candidate.sessionId, itemId, phase, eventIds: [], deltas: [], text: "" };
    group.eventIds.push(row.event_id);
    group.deltas.push(delta);
    group.text += delta;
    groups.set(key, group);
  }
  const inventory = [];
  for (const group of groups.values()) {
    const transcript = await pool.query(`
      SELECT m.id::text AS message_id, m.canonical_turn_id, m.canonical_run_attempt_id, m.canonical_item_id, m.canonical_phase,
             p.id::text AS part_id, p.part_type, p.source_event_id,
             p.content_json->>'text' AS part_text, p.session_sequence
        FROM messages m JOIN message_parts p ON p.message_id = m.id AND p.session_id = m.session_id
       WHERE m.session_id = $1 AND m.run_id = $2 AND m.role = 'assistant'
       ORDER BY m.id, p.session_sequence, p.id`, [group.sessionId, group.runId]);
    const messages = new Map();
    for (const row of transcript.rows) {
      const message = messages.get(row.message_id) ?? { messageId: row.message_id, canonicalTurnId: row.canonical_turn_id, canonicalRunAttemptId: row.canonical_run_attempt_id, canonicalItemId: row.canonical_item_id, canonicalPhase: row.canonical_phase, parts: [] };
      if (row.part_type === "text") message.parts.push({ partId: row.part_id, text: row.part_text ?? "", sourceEventId: row.source_event_id });
      messages.set(row.message_id, message);
    }
    const exact = [...messages.values()].filter((message) => message.parts.map((part) => part.text).join("") === group.text);
    const linked = exact.filter((message) => message.canonicalTurnId === group.turnId && message.canonicalRunAttemptId === group.runAttemptId && message.canonicalItemId === group.itemId && message.canonicalPhase === group.phase);
    let state = linked.length === 1 ? "projected" : exact.length > 1 ? "ambiguous_duplicate_transcript_text" : exact.length === 0 ? "no_exact_transcript_match" : "verified_transcript_text_but_missing_event_linkage";
    let repair = "none";
    const message = exact.length === 1 ? exact[0] : null;
    const expectedIdentity = [group.turnId, group.runAttemptId, group.itemId, group.phase];
    const actualIdentity = message ? [message.canonicalTurnId, message.canonicalRunAttemptId, message.canonicalItemId, message.canonicalPhase] : [];
    const identityConflict = message && actualIdentity.some((value, index) => value !== null && value !== expectedIdentity[index]);
    if (linked.length === 1) repair = "already_projected";
    else if (identityConflict) state = "transcript_identity_conflict";
    else if (message && ["commentary", "final_answer"].includes(group.phase) && message.parts.length === group.eventIds.length && message.parts.every((part, index) => part.text === group.deltas[index] && (part.sourceEventId === null || part.sourceEventId === group.eventIds[index]))) {
      state = "verified_exact_item_and_event_parts";
      repair = "attach_exact_event_projection_identity";
    } else if (message) state = "verified_text_without_event_part_alignment";
    inventory.push({
      turnId: group.turnId,
      sessionId: group.sessionId,
      runId: group.runId,
      runAttemptId: group.runAttemptId,
      itemId: group.itemId,
      phase: group.phase,
      eventCount: group.eventIds.length,
      eventIdsFingerprint: sha256(Buffer.from(stableJson(group.eventIds))),
      transcriptMatches: exact.length,
      exactIdentityLinks: linked.length,
      state,
      repair,
      ...(repair === "attach_exact_event_projection_identity" && message ? { messageId: message.messageId, eventPartLinks: message.parts.map((part, index) => ({ partId: part.partId, eventId: group.eventIds[index] })) } : {}),
    });
  }
  const claimedMessages = new Map();
  for (const item of inventory.filter((group) => group.repair === "attach_exact_event_projection_identity")) {
    const prior = claimedMessages.get(item.messageId);
    if (prior) {
      for (const ambiguous of [item, prior]) {
        ambiguous.repair = "none";
        ambiguous.state = "ambiguous_duplicate_transcript_text";
        delete ambiguous.messageId;
        delete ambiguous.eventPartLinks;
      }
    } else claimedMessages.set(item.messageId, item);
  }
  return {
    lifecycleAssistantDeltaCount: eventRows.rowCount,
    eventsWithoutVerifiedIdentityOrPhase: unmatchedEventCount,
    verifiedExistingTranscript: inventory.filter((item) => item.state === "verified_exact_item_and_event_parts" || item.state === "verified_transcript_text_but_missing_event_linkage").length,
    unresolved: inventory.filter((item) => item.state === "no_exact_transcript_match" || item.state === "ambiguous_duplicate_transcript_text").length,
    groups: inventory,
  };
}

async function inventoryLegacyStatus(pool) {
  const result = await pool.query(`
    SELECT s.id::text AS session_id, s.status AS session_status,
           s.active_run_id, r.status AS run_status,
           EXISTS (
             SELECT 1 FROM canonical_lifecycle_events e
             JOIN canonical_turn_admissions a ON a.turn_id = e.turn_id
              WHERE a.session_id = s.id AND a.run_id = s.active_run_id
                AND e.event_type IN ('turn.completed','turn.failed','turn.interrupted','turn.cancelled','turn.timed_out')
           ) AS has_canonical_terminal
      FROM sessions s
      LEFT JOIN runs r ON r.id = s.active_run_id
     WHERE (s.status = 'running' AND s.active_run_id IS NULL)
        OR (s.status = 'running' AND r.status IN ('completed','failed','cancelled','interrupted','timed_out') AND NOT EXISTS (
             SELECT 1 FROM canonical_lifecycle_events e
             JOIN canonical_turn_admissions a ON a.turn_id = e.turn_id
              WHERE a.session_id = s.id AND a.run_id = s.active_run_id
                AND e.event_type IN ('turn.completed','turn.failed','turn.interrupted','turn.cancelled','turn.timed_out')
        ))
     ORDER BY s.id`);
  return {
    unresolvedCount: result.rowCount,
    sessions: result.rows.map((row) => ({
      sessionId: row.session_id,
      sessionStatus: row.session_status,
      activeRunId: row.active_run_id,
      runStatus: row.run_status,
      canonicalTerminalFound: row.has_canonical_terminal,
      inferredOutcome: null,
      repair: "none; status and lifecycle history are left unchanged",
    })),
  };
}

async function verifyApplyEvidence(options, connectionString, manifest) {
  const backup = realpathSync(options.backupPath);
  if (!statSync(backup).isFile() || statSync(backup).size === 0) throw new Error("Backup evidence must be a non-empty regular file");
  const evidence = JSON.parse(readFileSync(options.restoreEvidencePath, "utf8"));
  if (evidence.status !== "verified" || evidence.backupSha256 !== sha256(readFileSync(backup))) {
    throw new Error("Restore evidence must confirm a verified restore of the supplied backup checksum");
  }
  if (evidence.targetDatabaseFingerprint !== databaseFingerprint(connectionString)) {
    throw new Error("Restore evidence target database does not match the selected database");
  }
  const rowCounts = evidence.rowCounts;
  if (!rowCounts || rowCounts.sessions !== manifest.sourceCounts.sessions || rowCounts.messages !== manifest.sourceCounts.messages || rowCounts.messageParts !== manifest.sourceCounts.messageParts || rowCounts.lifecycleEvents !== manifest.sourceCounts.lifecycleEvents) {
    throw new Error("Restore evidence row counts do not match the database being migrated");
  }
}

async function applyPlan(pool, manifest, manifestHash) {
  for (const session of manifest.sessions) {
    if (session.conflicts.length > 0) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(`
        SELECT s.id::text, s.thread_id, s.thread_binding_source, s.thread_binding_migration_id,
               s.current_turn_id
          FROM sessions s WHERE s.id = $1 FOR UPDATE`, [session.sessionId]);
      if (!locked.rows[0]) throw new Error("Session disappeared after inventory");
      const current = await sessionContent(client, session.sessionId);
      if (current.fingerprint !== session.contentFingerprint) throw new Error(`Session ${session.sessionId} content changed after dry-run; regenerate manifest`);
      const priorThread = locked.rows[0].thread_id;
      if (priorThread && priorThread !== session.threadId) throw new Error(`Session ${session.sessionId} thread binding changed after dry-run`);
      const savedCheckpoint = await client.query(`
        SELECT source_fingerprint, target_fingerprint, status, message_count, part_count, details_json
          FROM conversation_recovery_checkpoints
         WHERE migration_id = $1 AND session_id = $2`, [MIGRATION_ID, session.sessionId]);
      if (savedCheckpoint.rows[0]) {
        const checkpoint = savedCheckpoint.rows[0];
        if (!recoveryCheckpointCurrentTurnMatches(locked.rows[0].current_turn_id, session.recoveredCurrentTurnId, checkpoint.details_json?.expectedCurrentTurnId) || checkpoint.status !== "completed" || checkpoint.source_fingerprint !== session.contentFingerprint || checkpoint.target_fingerprint !== session.contentFingerprint || checkpoint.message_count !== session.messageCount || checkpoint.part_count !== session.partCount || checkpoint.details_json?.targetFingerprint !== session.contentFingerprint || checkpoint.details_json?.manifestHash !== manifestHash) {
          throw new Error(`Session ${session.sessionId} has a recovery checkpoint mismatch`);
        }
        for (const admission of session.importedAdmissions) {
          const existing = await client.query(`
            SELECT thread_id, turn_id, run_attempt_id, run_id, admission_order,
                   workspace_id, revision_of_turn_id, execution_state, provenance
              FROM canonical_turn_admissions
             WHERE session_id = $1 AND client_message_id = $2`, [session.sessionId, admission.clientMessageId]);
          const stored = existing.rows[0];
          if (!stored || stored.thread_id !== admission.threadId || stored.turn_id !== admission.turnId || stored.run_attempt_id !== admission.runAttemptId || stored.run_id !== admission.runId || Number(stored.admission_order) !== Number(admission.promptSequence) || stored.workspace_id !== session.workspaceId || stored.revision_of_turn_id !== (admission.revisionOfTurnId ?? null) || stored.execution_state !== admission.executionState || stored.provenance !== "legacy_recovery") {
            throw new Error(`Session ${session.sessionId} checkpoint is missing an imported admission`);
          }
        }
        for (const repair of session.projectionRepairs ?? []) {
          const message = await client.query(`SELECT canonical_turn_id, canonical_run_attempt_id, canonical_item_id, canonical_phase FROM messages WHERE id = $1 AND session_id = $2`, [repair.messageId, repair.sessionId]);
          const linked = message.rows[0];
          if (!linked || linked.canonical_turn_id !== repair.turnId || linked.canonical_run_attempt_id !== repair.runAttemptId || linked.canonical_item_id !== repair.itemId || linked.canonical_phase !== repair.phase) throw new Error(`Session ${session.sessionId} checkpoint projection identity is missing`);
          for (const part of repair.eventPartLinks ?? []) {
            const eventLink = await client.query("SELECT source_event_id FROM message_parts WHERE id = $1 AND session_id = $2", [part.partId, repair.sessionId]);
            if (eventLink.rows[0]?.source_event_id !== part.eventId) throw new Error(`Session ${session.sessionId} checkpoint event projection is missing`);
          }
        }
        await client.query("COMMIT");
        continue;
      }
      if (locked.rows[0].current_turn_id !== session.existingCurrentTurnId) throw new Error(`Session ${session.sessionId} current turn changed after dry-run; regenerate manifest`);
      if (locked.rows[0].current_turn_id && locked.rows[0].current_turn_id !== session.recoveredCurrentTurnId) throw new Error(`Session ${session.sessionId} has an existing current turn that conflicts with verified recovery evidence`);
      await client.query(`
      UPDATE sessions
         SET thread_id = COALESCE(thread_id, $2),
             thread_binding_source = COALESCE(thread_binding_source, $3),
             thread_binding_migration_id = COALESCE(thread_binding_migration_id, $4),
             thread_id_migrated_at = CASE WHEN thread_id IS NULL THEN COALESCE(thread_id_migrated_at, now()) ELSE thread_id_migrated_at END
       WHERE id = $1`, [session.sessionId, session.threadId, session.threadBindingSource, MIGRATION_ID]);
      for (const admission of session.importedAdmissions) {
        const clientMessageId = admission.clientMessageId;
        if (!clientMessageId) continue;
        await client.query(`
          INSERT INTO canonical_turn_admissions
            (session_id, client_message_id, thread_id, turn_id, run_attempt_id, run_id, admission_order,
             workspace_id, revision_of_turn_id, admission_state, execution_state,
             request_fingerprint, provenance, admitted_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'admitted',$10,NULL,'legacy_recovery',now())
          ON CONFLICT (session_id, client_message_id) DO NOTHING`, [
          session.sessionId, clientMessageId, admission.threadId, admission.turnId,
          admission.runAttemptId, admission.runId, Number(admission.promptSequence), session.workspaceId,
          admission.revisionOfTurnId ?? null, admission.executionState,
        ]);
        const admissionRow = await client.query(`
          SELECT thread_id, turn_id, run_attempt_id, run_id, admission_order,
                 workspace_id, revision_of_turn_id, execution_state, provenance
            FROM canonical_turn_admissions
           WHERE session_id = $1 AND client_message_id = $2`, [session.sessionId, clientMessageId]);
        const stored = admissionRow.rows[0];
        if (!stored || stored.thread_id !== admission.threadId || stored.turn_id !== admission.turnId || stored.run_attempt_id !== admission.runAttemptId || stored.run_id !== admission.runId || Number(stored.admission_order) !== Number(admission.promptSequence) || stored.workspace_id !== session.workspaceId || stored.revision_of_turn_id !== (admission.revisionOfTurnId ?? null) || stored.execution_state !== admission.executionState || stored.provenance !== "legacy_recovery") {
          throw new Error(`Session ${session.sessionId} admission identity conflicts with an existing canonical record`);
        }
      }
      if (session.importedAdmissions.length > 0) {
        const latestOrder = Math.max(...session.importedAdmissions.map((entry) => Number(entry.promptSequence)));
        await client.query(`
          UPDATE sessions
             SET current_turn_id = $2,
                 admission_sequence = GREATEST(admission_sequence, $3)
           WHERE id = $1`, [session.sessionId, session.recoveredCurrentTurnId, latestOrder]);
      } else {
        await client.query(`UPDATE sessions SET current_turn_id = $2 WHERE id = $1`, [session.sessionId, session.recoveredCurrentTurnId]);
      }
      for (const repair of session.projectionRepairs ?? []) {
        const linkedMessage = await client.query(`
          UPDATE messages
             SET canonical_turn_id = $2, canonical_run_attempt_id = $3,
                 canonical_item_id = $4, canonical_phase = $5
           WHERE id = $1 AND session_id = $6 AND role = 'assistant'
             AND (canonical_turn_id IS NULL OR canonical_turn_id = $2)
             AND (canonical_run_attempt_id IS NULL OR canonical_run_attempt_id = $3)
             AND (canonical_item_id IS NULL OR canonical_item_id = $4)
             AND (canonical_phase IS NULL OR canonical_phase = $5)`, [
          repair.messageId, repair.turnId, repair.runAttemptId, repair.itemId, repair.phase, repair.sessionId,
        ]);
        if (linkedMessage.rowCount !== 1) throw new Error(`Projection message ${repair.messageId} changed or conflicts with verified identity`);
        for (const part of repair.eventPartLinks ?? []) {
          const linkedPart = await client.query(`
            UPDATE message_parts
               SET source_event_id = $2
             WHERE id = $1 AND session_id = $3
               AND (source_event_id IS NULL OR source_event_id = $2)`, [part.partId, part.eventId, repair.sessionId]);
          if (linkedPart.rowCount !== 1) throw new Error(`Projection part ${part.partId} changed or conflicts with verified event linkage`);
        }
      }
      const after = await sessionContent(client, session.sessionId);
      if (after.fingerprint !== session.contentFingerprint) throw new Error(`Session ${session.sessionId} transcript fingerprint changed during recovery`);
      await client.query(`
        INSERT INTO conversation_recovery_checkpoints
          (migration_id, session_id, source_fingerprint, target_fingerprint, status, message_count, part_count, details_json, migrated_at)
        VALUES ($1,$2,$3,$3,'completed',$4,$5,$6::jsonb,now())`, [
        MIGRATION_ID, session.sessionId, session.contentFingerprint,
        session.messageCount, session.partCount,
        JSON.stringify({ manifestHash, migrationId: MIGRATION_ID, targetFingerprint: session.contentFingerprint, messageCount: session.messageCount, partCount: session.partCount, importedAdmissions: session.verifiedExactTuples, expectedCurrentTurnId: session.recoveredCurrentTurnId }),
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

async function verifyPostApply(pool, sessions) {
  const result = [];
  for (const session of sessions) {
    if (session.conflicts.length) continue;
    const row = await pool.query("SELECT thread_id FROM sessions WHERE id = $1", [session.sessionId]);
    const content = await sessionContent(pool, session.sessionId);
    result.push({ sessionId: session.sessionId, threadIdMatches: row.rows[0]?.thread_id === session.threadId, contentFingerprintMatches: content.fingerprint === session.contentFingerprint });
  }
  return { verifiedSessionCount: result.filter((entry) => entry.threadIdMatches && entry.contentFingerprintMatches).length, sessions: result };
}

async function writePrivateManifest(filePath, manifest) {
  const resolved = path.resolve(filePath);
  if (!path.isAbsolute(resolved)) throw new Error("Manifest path must be absolute");
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error("Manifest must be stored outside the repository");
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  writeFileSync(resolved, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(resolved, 0o600);
}

function readPrivateManifest(filePath) {
  const absolute = path.resolve(filePath);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error("Recovery manifest must be a regular private file with permissions restricted to its owner");
  }
  const resolved = realpathSync(absolute);
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error("Recovery manifest must be stored outside the repository");
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function report(manifest) {
  console.log(JSON.stringify({
    mode: manifest.mode,
    manifestHash: manifest.manifestHash,
    sessionCount: manifest.sessionCount,
    eligibleSessionCount: manifest.eligibleSessionCount,
    conflictCount: manifest.conflictCount,
    exactTupleCount: manifest.sessions.reduce((count, session) => count + session.verifiedExactTuples, 0),
    unverifiableIdentityCount: manifest.sessions.reduce((count, session) => count + session.unverifiableIdentityCandidates, 0),
    legacyBindingCount: manifest.sessions.filter((session) => session.status === "legacy_binding").length,
    artifactReferenceCount: manifest.artifactInventory.referenceCount,
    verifiedArtifactBytes: manifest.artifactInventory.verifiedLocalReferences,
    artifactMetadataReferences: manifest.artifactInventory.metadataReferenceCount,
    verifiedArtifactMetadataBytes: manifest.artifactInventory.verifiedMetadataReferences,
    mediaReferences: manifest.artifactInventory.mediaReferenceCount,
    verifiedMediaBytes: manifest.artifactInventory.verifiedMediaReferences,
    assistantProjectionGroups: manifest.assistantProjectionInventory.groups.length,
    assistantProjectionUnresolved: manifest.assistantProjectionInventory.unresolved,
    assistantEventsWithoutVerifiedTuple: manifest.assistantProjectionInventory.eventsWithoutVerifiedIdentityOrPhase,
    legacyStatusUnresolved: manifest.legacyStatusInventory.unresolvedCount,
    externalProviderMigration: manifest.externalProviderMigration,
  }, null, 2));
}

function stableLegacyThread(sessionId) {
  const value = sha256(Buffer.from(`legioncode:legacy-thread:v1:${sessionId}`)).slice(0, 32);
  return `thr_legacy_${value}`;
}

function databaseFingerprint(connectionString) {
  const url = new URL(connectionString);
  const identity = [url.protocol, url.hostname.toLowerCase(), url.port || "5432", url.pathname].join("|");
  return sha256(Buffer.from(identity));
}
function shortId(value) { return sha256(Buffer.from(value)).slice(0, 12); }

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value) { return JSON.stringify(sortRecursively(value)); }
function comparisonShape(value) {
  const copy = structuredClone(value);
  delete copy.mode;
  delete copy.generatedAt;
  delete copy.manifestHash;
  return stableJson(copy);
}
function assertManifestFresh(prior, current) {
  if (prior.version !== MANIFEST_VERSION || prior.mode !== "dry-run") throw new Error("Invalid recovery inventory manifest");
  if (prior.databaseFingerprint !== current.databaseFingerprint || stableJson(prior.roots) !== stableJson(current.roots) || stableJson(prior.identityAuditFingerprints) !== stableJson(current.identityAuditFingerprints)) {
    throw new Error("Database or read-only runtime inventory changed after dry-run; regenerate the manifest");
  }
  if (stableJson(prior.sourceCounts) !== stableJson(current.sourceCounts)) throw new Error("Source row counts changed after dry-run; regenerate the manifest");
  if (prior.sessions.length !== current.sessions.length) throw new Error("Conversation inventory changed after dry-run; regenerate the manifest");
  const currentById = new Map(current.sessions.map((session) => [session.sessionId, session]));
  for (const session of prior.sessions) {
    const fresh = currentById.get(session.sessionId);
    if (!fresh || fresh.ownerId !== session.ownerId || fresh.workspaceId !== session.workspaceId || fresh.messageCount !== session.messageCount || fresh.partCount !== session.partCount || fresh.archivedAt !== session.archivedAt || fresh.contentFingerprint !== session.contentFingerprint) {
      throw new Error(`Conversation ${session.sessionId} changed after dry-run; regenerate the manifest`);
    }
    if (stableJson(recoveryProofShape(session)) !== stableJson(recoveryProofShape(fresh))) {
      throw new Error(`Conversation ${session.sessionId} ownership or exact identity proof changed after dry-run; regenerate the manifest`);
    }
  }
  const projectionEvidence = (value) => value.assistantProjectionInventory.groups.map(({ turnId, runAttemptId, itemId, phase, eventIdsFingerprint }) => ({ turnId, runAttemptId, itemId, phase, eventIdsFingerprint }));
  const rawStatusEvidence = (value) => value.legacyStatusInventory.sessions.map(({ sessionId, sessionStatus, activeRunId, runStatus }) => ({ sessionId, sessionStatus, activeRunId, runStatus }));
  if (stableJson(prior.artifactInventory) !== stableJson(current.artifactInventory) || stableJson(projectionEvidence(prior)) !== stableJson(projectionEvidence(current)) || stableJson(rawStatusEvidence(prior)) !== stableJson(rawStatusEvidence(current))) {
    throw new Error("Artifact or lifecycle evidence changed after dry-run; regenerate the manifest");
  }
}
function sortRecursively(value) {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortRecursively(value[key])]));
  return value;
}
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
