#ifndef LEGIONCODE_HOST_RETIREMENT_H
#define LEGIONCODE_HOST_RETIREMENT_H
#include "legioncode-host-scope.h"

/* This commitment is created by the trusted host ONLY in the existing physical
 * writer's onReleased callback, after its full captured/Git resource proof. It
 * is an additional barrier, never authority to signal a UID or clean up ACLs. */
static inline void lc_host_retirement_digest(const lc_host_scope_record *record, unsigned char out[32]) {
  static const char domain[] = "LegionCode/native-host/physical-retirement/v1";
  CC_SHA256_CTX hash; CC_SHA256_Init(&hash); CC_SHA256_Update(&hash, domain, sizeof(domain));
  CC_SHA256_Update(&hash, record->retirement_nonce, 32); CC_SHA256_Update(&hash, record->cleanup_receipt, 32);
  CC_SHA256_Update(&hash, record->binding.resource_id, 32);
  CC_SHA256_Update(&hash, record->binding.broker_resource_generation, 32);
  uint64_t numbers[] = { record->uid_slot_generation, record->binding.root.device, record->binding.root.inode,
    record->binding.namespace.device, record->binding.namespace.inode, record->binding.fence.device, record->binding.fence.inode };
  for (size_t i = 0; i < sizeof(numbers) / sizeof(numbers[0]); i++) {
    unsigned char bytes[8]; uint64_t value = numbers[i];
    for (size_t j = 0; j < 8; j++) { bytes[7 - j] = (unsigned char)value; value >>= 8; }
    CC_SHA256_Update(&hash, bytes, sizeof(bytes));
  }
  CC_SHA256_Update(&hash, record->metadata.identity, (CC_LONG)strlen(record->metadata.identity) + 1);
  CC_SHA256_Final(out, &hash);
}
static inline bool lc_host_retirement_begin(int state, lc_host_scope *scope) {
  if (!scope->released || !scope->sealed || scope->retirement_unknown || scope->record.phase != LC_HOST_CLOSED || !scope->record.cleanup_closed ||
      scope->record.retirement_confirmed || !scope->approval ||
      !lc_host_reservation_current(state, scope->approval, &scope->record.binding, scope->record.uid_slot_generation)) return false;
  if (scope->record.retirement_requested) return true;
  scope->record.retirement_requested = 1;
  arc4random_buf(scope->record.retirement_nonce, 32);
  if (!lc_host_scope_save(state, scope)) { scope->retirement_unknown = true; return false; }
  return true;
}
static inline bool lc_host_retirement_matches(const lc_host_scope_record *record, xpc_object_t request) {
  static const char *const fields[] = { "version", "operation", "generation", "capability", "resourceId",
    "resourceGeneration", "slotGeneration", "cleanupReceipt", "retirementNonce", "hostReleaseSHA256" };
  if (!lc_host_fields(request, fields, sizeof(fields) / sizeof(fields[0]))) return false;
  const char *keys[] = { "resourceId", "resourceGeneration", "cleanupReceipt", "retirementNonce" };
  const unsigned char *values[] = { record->binding.resource_id, record->binding.broker_resource_generation,
    record->cleanup_receipt, record->retirement_nonce };
  for (size_t i = 0; i < 4; i++) {
    char supplied[65]; unsigned char decoded[32];
    if (!lc_host_get(request, keys[i], supplied, sizeof(supplied)) || !lc_host_unhex(supplied, decoded, 32) ||
        memcmp(decoded, values[i], 32)) return false;
  }
  char supplied[65], expected_generation[32]; unsigned char receipt[32], expected[32];
  snprintf(expected_generation, sizeof(expected_generation), "%llu", (unsigned long long)record->uid_slot_generation);
  if (!lc_host_get(request, "slotGeneration", supplied, sizeof(supplied)) || strcmp(supplied, expected_generation) ||
      !lc_host_get(request, "hostReleaseSHA256", supplied, sizeof(supplied)) || !lc_host_unhex(supplied, receipt, 32)) return false;
  lc_host_retirement_digest(record, expected); return !memcmp(receipt, expected, 32);
}
static inline bool lc_host_retirement_finish(int state, const lc_host_approval *approval,
    lc_host_scope *scope, xpc_object_t request) {
  if (!scope->released || !scope->sealed || scope->retirement_unknown ||
      !scope->owner_disconnected || scope->record.phase != LC_HOST_CLOSED || !scope->record.cleanup_closed ||
      !scope->record.retirement_requested || !lc_host_retirement_matches(&scope->record, request)) return false;
  unsigned char receipt[32]; lc_host_retirement_digest(&scope->record, receipt);
  lc_host_reservation previous;
  if (!lc_host_reservation_read(state, approval, scope->record.principal.uid, &previous) ||
      previous.slot_generation != scope->record.uid_slot_generation ||
      memcmp(&previous.binding, &scope->record.binding, sizeof(previous.binding))) return false;
  if (scope->record.retirement_confirmed) {
    if (memcmp(scope->record.retirement_receipt, receipt, 32)) return false;
  } else {
    if (previous.state != LC_HOST_SLOT_CLAIMED) return false;
    scope->record.retirement_confirmed = 1; memcpy(scope->record.retirement_receipt, receipt, 32);
    /* Historical completion MUST be durable before this slot becomes available.
     * Failure is sticky in custody: no subsequent request repairs an uncertain
     * fsync acknowledgement merely by reading back visible bytes. */
    if (!lc_host_scope_save(state, scope)) { scope->retirement_unknown = true; return false; }
  }
  if (scope->retirement_unknown) return false;
  if (previous.state == LC_HOST_SLOT_AVAILABLE)
    return !memcmp(previous.cleanup_receipt, scope->record.cleanup_receipt, 32) && !memcmp(previous.retirement_receipt, receipt, 32);
  lc_host_reservation next = previous; next.state = LC_HOST_SLOT_AVAILABLE;
  memcpy(next.cleanup_receipt, scope->record.cleanup_receipt, 32); memcpy(next.retirement_receipt, receipt, 32);
  if (!lc_host_reservation_replace(state, approval, &previous, &next)) { scope->retirement_unknown = true; return false; }
  return true;
}
#endif
