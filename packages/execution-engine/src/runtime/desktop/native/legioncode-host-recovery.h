#ifndef LEGIONCODE_HOST_RECOVERY_H
#define LEGIONCODE_HOST_RECOVERY_H
#include "legioncode-host-scope.h"

static inline bool lc_host_recovery_number(xpc_object_t request, const char *key, uint64_t expected) {
  char value[32], canonical[32];
  snprintf(canonical, sizeof(canonical), "%llu", (unsigned long long)expected);
  return lc_host_get(request, key, value, sizeof(value)) && !strcmp(value, canonical);
}
static inline xpc_object_t lc_host_recovery_reply(const lc_host_approval *approval,
    const lc_host_scope_record *record, bool live) {
  bool closed = record->cleanup_closed == 1 && record->phase == LC_HOST_CLOSED;
  xpc_object_t reply = lc_host_reply(closed ? "cleanupClosed" : live && record->phase != LC_HOST_UNKNOWN ? "cleanupPending" : "unknown", "okay");
  lc_host_put(reply, "generation", approval->generation);
  lc_host_put(reply, "originGeneration", record->origin_generation);
  lc_host_put(reply, "originBoot", record->boot);
  lc_host_put(reply, "cleanupBasis", closed ? "liveOriginalResources" : "unconfirmed");
  char digest[65];
  #define LC_RECOVERY_DIGEST(key, bytes) do { lc_host_hex(bytes, 32, digest, sizeof(digest)); lc_host_put(reply, key, digest); } while (0)
  LC_RECOVERY_DIGEST("scopeSHA256", record->binding.scope_sha256);
  LC_RECOVERY_DIGEST("resourceId", record->binding.resource_id);
  LC_RECOVERY_DIGEST("resourceGeneration", record->binding.broker_resource_generation);
  LC_RECOVERY_DIGEST("policy", record->binding.policy_sha256);
  LC_RECOVERY_DIGEST("policyGeneration", record->binding.approved_policy_generation);
  LC_RECOVERY_DIGEST("capabilitySHA256", record->binding.capability_sha256);
  LC_RECOVERY_DIGEST("receiptId", record->cleanup_receipt);
  unsigned char binding[32]; CC_SHA256(&record->binding, sizeof(record->binding), binding);
  LC_RECOVERY_DIGEST("bindingSHA256", binding);
  LC_RECOVERY_DIGEST("metadataSHA256", record->metadata.digest);
  #undef LC_RECOVERY_DIGEST
  lc_host_put_number(reply, "rootDevice", record->binding.root.device);
  lc_host_put_number(reply, "rootInode", record->binding.root.inode);
  lc_host_put_number(reply, "namespaceDevice", record->binding.namespace.device);
  lc_host_put_number(reply, "namespaceInode", record->binding.namespace.inode);
  lc_host_put_number(reply, "fenceDevice", record->binding.fence.device);
  lc_host_put_number(reply, "fenceInode", record->binding.fence.inode);
  return reply;
}
/* The exact actor has already passed kernel-backed XPC code/bundle checks.
 * This endpoint can ONLY observe or seal; it cannot release any command gate. */
static inline xpc_object_t lc_host_recovery(int state, const lc_host_approval *approval,
    xpc_object_t request, lc_host_scope *scopes, bool seal) {
  static const char *const fields[] = { "version", "operation", "generation", "workspaceId", "threadId", "runId", "turnId", "runAttemptId",
    "rootDevice", "rootInode", "namespaceDevice", "namespaceInode", "fenceDevice", "fenceInode", "resourceId", "resourceGeneration" };
  unsigned char scope[32]; lc_host_scope_record record; char name[80]; bool present;
  if (!lc_host_fields(request, fields, sizeof(fields) / sizeof(fields[0])) || !lc_host_request_scope(request, scope)) return lc_host_reply("unavailable", "invalidRequest");
  if (!lc_host_record_find(state, approval->actor, scope, &record, name, &present)) return lc_host_reply("unknown", "protectedResourceRecordInvalid");
  bool reserved;
  if (!lc_host_reservation_seen(state, approval, scope, &reserved)) return lc_host_reply("unknown", "protectedReservationInvalid");
  if (present && record.purpose != LC_HOST_RESOURCE_NATIVE) return lc_host_reply("unavailable", "resourcePurposeConflict");
  if (!present || (!reserved && !record.retirement_confirmed)) return lc_host_reply("unknown", "resourceRecoveryRequired");
  /* Historical closed receipts are observations of their original resources.
   * They never inspect/signal/settle the current occupant of a reused UID. */
  if (!record.retirement_confirmed && !lc_host_reservation_current(state, approval,
      &record.binding, record.uid_slot_generation)) return lc_host_reply("unknown", "protectedReservationInvalid");
  if (strcmp(record.origin_generation, approval->generation)) return lc_host_reply("unknown", "daemonRestartRecoveryRequired");
  if (!lc_host_recovery_number(request, "rootDevice", record.binding.root.device) ||
      !lc_host_recovery_number(request, "rootInode", record.binding.root.inode) ||
      !lc_host_recovery_number(request, "namespaceDevice", record.binding.namespace.device) ||
      !lc_host_recovery_number(request, "namespaceInode", record.binding.namespace.inode) ||
      !lc_host_recovery_number(request, "fenceDevice", record.binding.fence.device) ||
      !lc_host_recovery_number(request, "fenceInode", record.binding.fence.inode)) return lc_host_reply("unknown", "resourceIdentityConflict");
  char expected[65];
  for (size_t i = 0; i < 2; i++) {
    const char *key = i ? "resourceGeneration" : "resourceId";
    lc_host_hex(i ? record.binding.broker_resource_generation : record.binding.resource_id, 32, expected, sizeof(expected));
    xpc_object_t value = xpc_dictionary_get_value(request, key);
    if (!value || xpc_get_type(value) != XPC_TYPE_DATA) return lc_host_reply("unavailable", "invalidRequest");
    size_t bytes = xpc_data_get_length(value);
    /* Discovery explicitly permits an EMPTY expected resource. The ordinary
     * nonempty text decoder intentionally cannot express this case. */
    if ((!bytes && seal) || (bytes && (bytes != 64 || memcmp(xpc_data_get_bytes_ptr(value), expected, 64))))
      return lc_host_reply("unknown", "resourceIdentityConflict");
  }
  lc_host_scope *live = NULL;
  for (size_t i = 0; i < LC_HOST_MAX_SCOPES; i++) {
    if (!scopes[i].used || memcmp(scopes[i].record.binding.resource_id, record.binding.resource_id, 32)) continue;
    if (live || memcmp(&scopes[i].record.binding, &record.binding, sizeof(record.binding))) return lc_host_reply("unknown", "resourceIdentityConflict");
    live = &scopes[i];
  }
  if (seal && !record.cleanup_closed) {
    if (!live || !lc_host_scope_seal(state, live)) return lc_host_reply("unknown", "resourceRecoveryRequired");
    lc_host_scope_tick(state, live);
    /* Read the durable record, never infer a receipt from an in-memory phase. */
    if (!lc_host_record_read(state, name, &record)) return lc_host_reply("unknown", "protectedResourceRecordInvalid");
  }
  /* A readable rename after a failed fsync is not a durable acknowledgement.
   * An unknown live owner must never be overridden by older visible disk bytes. */
  if (live && (live->record.phase == LC_HOST_UNKNOWN || (record.cleanup_closed &&
      (!live->released || !live->record.cleanup_closed || live->record.phase != LC_HOST_CLOSED ||
       memcmp(live->record.cleanup_receipt, record.cleanup_receipt, 32)))))
    return lc_host_reply("unknown", "cleanupPersistenceUnconfirmed");
  return lc_host_recovery_reply(approval, &record, live != NULL);
}
#endif
