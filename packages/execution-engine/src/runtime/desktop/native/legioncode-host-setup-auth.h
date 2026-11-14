#ifndef LEGIONCODE_HOST_SETUP_AUTH_H
#define LEGIONCODE_HOST_SETUP_AUTH_H
#include "legioncode-host-record.h"

typedef struct {
  uint32_t version, bytes, purpose, actor;
  char boot[40], generation[65], permit[65], qualification_id[65];
  lc_host_file_identity namespace;
  unsigned char manifest_sha256[32], bridge_nonce[32], resource_capability_sha256[32];
  _Alignas(8) unsigned char digest[32];
} lc_host_setup_permit_consumption;
_Static_assert(offsetof(lc_host_setup_permit_consumption, digest) + 32 == sizeof(lc_host_setup_permit_consumption),
  "Permit digest covers complete consumption");

/* Ordered setup scope, never fabricated workspace/thread/run/Turn fields. The
 * complete manifest digest additionally binds the approved bridge/resource map. */
static inline bool lc_host_setup_scope_sha256(const lc_host_approval *approval,
    const unsigned char nonce[32], const lc_host_writer_binding *binding, const char boot[40], unsigned char out[32]) {
  static const char domain[] = "LegionCode/native-host/setup-qualification/v1";
  char bundle_hash[129], broker_hash[65]; unsigned char broker[32], actor[4];
  if (binding->actor_uid != approval->actor || !lc_host_boot_field(boot) ||
      !lc_host_text(CFDictionaryGetValue(approval->manifest, CFSTR("BundleCDHash")), bundle_hash, sizeof(bundle_hash)) ||
      !lc_host_text(CFDictionaryGetValue(approval->manifest, CFSTR("BrokerSHA256")), broker_hash, sizeof(broker_hash)) ||
      !lc_host_unhex(broker_hash, broker, sizeof(broker))) return false;
  lc_host_write32(actor, approval->actor); CC_SHA256_CTX hash; CC_SHA256_Init(&hash);
  CC_SHA256_Update(&hash, domain, sizeof(domain)); CC_SHA256_Update(&hash, nonce, 32);
  CC_SHA256_Update(&hash, actor, sizeof(actor)); CC_SHA256_Update(&hash, bundle_hash, (CC_LONG)strlen(bundle_hash) + 1);
  CC_SHA256_Update(&hash, broker, sizeof(broker)); CC_SHA256_Update(&hash, binding->policy_sha256, 32);
  CC_SHA256_Update(&hash, binding->approved_policy_generation, 32);
  CC_SHA256_Update(&hash, approval->kernel_release, (CC_LONG)strlen(approval->kernel_release) + 1);
  CC_SHA256_Update(&hash, boot, 40); CC_SHA256_Update(&hash, binding->resource_id, 32);
  CC_SHA256_Update(&hash, binding->broker_resource_generation, 32);
  CC_SHA256_Update(&hash, approval->generation, (CC_LONG)strlen(approval->generation) + 1);
  CC_SHA256_Update(&hash, approval->manifest_sha256, 32); CC_SHA256_Final(out, &hash); return true;
}
static inline bool lc_host_setup_namespace(const lc_host_approval *approval, xpc_object_t request) {
  xpc_object_t value = xpc_dictionary_get_value(request, "namespaceFd");
  if (!value || xpc_get_type(value) != XPC_TYPE_FD) return false;
  int fd = xpc_fd_dup(value); if (fd < 0) return false;
  struct stat st; char path[PATH_MAX];
  bool okay = !fstat(fd, &st) && S_ISDIR(st.st_mode) && st.st_uid == approval->actor && (st.st_mode & 0777) == 0700 &&
    (uint64_t)st.st_dev == approval->writer_namespace.device && (uint64_t)st.st_ino == approval->writer_namespace.inode &&
    !fcntl(fd, F_GETPATH, path) && !strcmp(path, approval->writer_namespace_path);
  if (close(fd)) okay = false; return okay;
}

/* One original, yielding, read-only query over the existing resource custody
 * directory. The deny seal is durable first; this scan grants no cleanup. */
typedef struct {
  bool used, blocked, ready, scanning;
  size_t principal_index;
  uint64_t setup_resource_count;
  unsigned char setup_resource_keys[32], consumed_resource_keys[32];
  const lc_host_approval *approval;
  lc_host_reauthorization_seal receipt;
  lc_host_record_scan history;
  CC_SHA256_CTX digest;
  bool (*qualification_entry)(int, const lc_host_approval *, const char *, unsigned char [32]);
} lc_host_reauthorization;
static inline bool lc_host_reauthorization_retired(const lc_host_approval *approval, const lc_host_scope_record *record) {
  bool principal = false;
  for (size_t i = 0; i < approval->principal_count; i++)
    if (approval->principals[i].uid == record->principal.uid && approval->principals[i].gid == record->principal.gid &&
        !memcmp(approval->principals[i].guid, record->principal.guid, 16)) principal = true;
  return principal && record->binding.actor_uid == approval->actor && record->phase == LC_HOST_CLOSED &&
    record->cleanup_closed == 1 && record->retirement_requested == 1 && record->retirement_confirmed == 1 &&
    lc_host_same(record->binding.namespace, approval->writer_namespace);
}
static inline bool lc_host_reauthorization_store(int state, const lc_host_approval *approval,
    lc_host_reauthorization_seal *receipt) {
  char name[96], next[112]; lc_host_reauthorization_seal old; bool present;
  if (!lc_host_reauthorization_seal_read(approval, approval->manifest_sha256, &old, &present) ||
      !lc_host_reauthorization_name(approval->manifest_sha256, name)) return false;
  snprintf(next, sizeof(next), "%s.next", name);
  receipt->version = LC_HOST_REAUTHORIZATION_SEAL_VERSION; receipt->bytes = sizeof(*receipt);
  CC_SHA256(receipt, (CC_LONG)offsetof(lc_host_reauthorization_seal, digest), receipt->digest);
  int fd = openat(state, next, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  bool okay = lc_host_protected_fd(fd, false) && lc_host_io(fd, receipt, sizeof(*receipt), true) && lc_host_sync(fd);
  if (close(fd)) okay = false;
  lc_host_reauthorization_seal current; bool current_present;
  if (!okay || !lc_host_reauthorization_seal_read(approval, approval->manifest_sha256, &current, &current_present) ||
      present != current_present || (present && memcmp(&old, &current, sizeof(old)))) return false;
  if (present ? renameat(state, next, state, name) : renameatx_np(state, next, state, name, RENAME_EXCL)) return false;
  return lc_host_sync(state);
}
static inline bool lc_host_reauthorization_permit(int state, const lc_host_approval *approval,
    const char *name, unsigned char out[32], unsigned char resource_key[32]) {
  unsigned char id[32], generation[32]; char path[PATH_MAX], resource[80], root[PATH_MAX]; struct stat st;
  if (strlen(name) != 77 || strncmp(name, "setup-permit.", 13) || !lc_host_unhex(name + 13, id, 32) ||
      snprintf(path, sizeof(path), "%s/%s", LC_HOST_STATE, name) >= (int)sizeof(path)) return false;
  int fd = lc_host_open_protected(path, false); if (fd < 0) return false;
  lc_host_setup_permit_consumption permit; memset(&permit, 0, sizeof(permit));
  bool okay = !fstat(fd, &st) && st.st_nlink == 1 && (st.st_mode & 07777) == 0600 &&
    st.st_size == sizeof(permit) && lc_host_io(fd, &permit, sizeof(permit), false);
  if (close(fd)) okay = false;
  unsigned char digest[32]; CC_SHA256(&permit, (CC_LONG)offsetof(lc_host_setup_permit_consumption, digest), digest);
  if (!okay || permit.version != 2 || permit.bytes != sizeof(permit) || permit.actor != approval->actor ||
      permit.purpose != LC_HOST_RESOURCE_SETUP_QUALIFICATION || !lc_host_boot_field(permit.boot) ||
      !memchr(permit.generation, 0, sizeof(permit.generation)) || !lc_host_unhex(permit.generation, generation, 32) ||
      !memchr(permit.permit, 0, sizeof(permit.permit)) || strcmp(permit.permit, name + 13) ||
      !memchr(permit.qualification_id, 0, sizeof(permit.qualification_id)) || !lc_host_unhex(permit.qualification_id, id, 32) ||
      !lc_host_nonzero(permit.bridge_nonce, 32) || !lc_host_nonzero(permit.resource_capability_sha256, 32) ||
      !lc_host_same(permit.namespace, approval->writer_namespace) || memcmp(digest, permit.digest, 32)) return false;
  char key[65]; lc_host_hex(permit.resource_capability_sha256, 32, key, sizeof(key));
  snprintf(resource, sizeof(resource), "resource.%s", key);
  lc_host_scope_record record;
  if (!lc_host_record_read(state, resource, &record) || !lc_host_reauthorization_retired(approval, &record) ||
      record.purpose != LC_HOST_RESOURCE_SETUP_QUALIFICATION || strcmp(record.origin_generation, permit.generation) ||
      memcmp(record.boot, permit.boot, sizeof(permit.boot)) || memcmp(record.setup_manifest_sha256, permit.manifest_sha256, 32) ||
      snprintf(root, sizeof(root), "%s/qualification.%s", LC_HOST_WORK, permit.qualification_id) >= (int)sizeof(root) ||
      strcmp(root, record.root_path)) return false;
  memcpy(out, permit.digest, 32); memcpy(resource_key, permit.resource_capability_sha256, 32); return true;
}
static inline bool lc_host_reauthorization_observe(int state, const char *name, void *context) {
  lc_host_reauthorization *query = context; const lc_host_approval *approval = query->approval;
  if (!name) {
    query->receipt.resource_count = query->receipt.slot_count = query->receipt.permit_count = 0;
    query->setup_resource_count = 0; memset(query->setup_resource_keys, 0, 32); memset(query->consumed_resource_keys, 0, 32);
    static const char domain[] = "LegionCode/native-host/retired-history/v1";
    CC_SHA256_Init(&query->digest); CC_SHA256_Update(&query->digest, domain, sizeof(domain)); return true;
  }
  if (!strcmp(name, ".") || !strcmp(name, "..")) return true;
  unsigned char digest[32]; memset(digest, 0, sizeof(digest));
  if (!strncmp(name, "resource.", 9)) {
    bool access = strlen(name) == 80 && !strcmp(name + 73, ".access");
    char resource[80]; snprintf(resource, sizeof(resource), "%s", name);
    if (access) resource[73] = 0;
    lc_host_scope_record record;
    if (!lc_host_record_read(state, resource, &record) || !lc_host_reauthorization_retired(approval, &record)) return false;
    if (access) {
      char path[PATH_MAX]; struct stat st;
      if (snprintf(path, sizeof(path), "%s/%s", LC_HOST_STATE, name) >= (int)sizeof(path)) return false;
      int fd = lc_host_open_protected(path, false); if (fd < 0) return false;
      bool okay = !fstat(fd, &st) && st.st_nlink == 1 && (st.st_mode & 07777) == 0600;
      if (close(fd)) okay = false;
      if (!okay) return false;
    } else {
      query->receipt.resource_count++;
      if (record.purpose == LC_HOST_RESOURCE_SETUP_QUALIFICATION) {
        query->setup_resource_count++;
        for (size_t i = 0; i < 32; i++) query->setup_resource_keys[i] ^= record.binding.capability_sha256[i];
      }
    }
    memcpy(digest, record.digest, 32);
  } else if (!strncmp(name, "used.", 5)) {
    char *end = NULL, canonical[64]; errno = 0; unsigned long uid = strtoul(name + 5, &end, 10);
    snprintf(canonical, sizeof(canonical), "used.%lu", uid);
    lc_host_reservation slot; char key[65], resource[80]; lc_host_scope_record record;
    if (errno || !end || *end || uid > UINT32_MAX || strcmp(name, canonical) ||
        !lc_host_reservation_read(state, approval, (uid_t)uid, &slot) || slot.state != LC_HOST_SLOT_AVAILABLE) return false;
    lc_host_hex(slot.binding.capability_sha256, 32, key, sizeof(key)); snprintf(resource, sizeof(resource), "resource.%s", key);
    if (!lc_host_record_read(state, resource, &record) || !lc_host_reauthorization_retired(approval, &record) ||
        memcmp(&slot.binding, &record.binding, sizeof(slot.binding)) || slot.slot_generation != record.uid_slot_generation ||
        memcmp(slot.cleanup_receipt, record.cleanup_receipt, 32) || memcmp(slot.retirement_receipt, record.retirement_receipt, 32)) return false;
    query->receipt.slot_count++; if (query->receipt.slot_count > approval->principal_count) return false;
    memcpy(digest, slot.digest, 32);
  } else if (!strncmp(name, "setup-permit.", 13)) {
    unsigned char resource_key[32];
    if (!lc_host_reauthorization_permit(state, approval, name, digest, resource_key)) return false;
    query->receipt.permit_count++;
    for (size_t i = 0; i < 32; i++) query->consumed_resource_keys[i] ^= resource_key[i];
  } else if (!strncmp(name, "qualification.", 14)) {
    if (!query->qualification_entry || !query->qualification_entry(state, approval, name, digest)) return false;
  } else if (!strncmp(name, "setup-seal.", 11)) {
    unsigned char configuration[32]; lc_host_reauthorization_seal seal; bool present;
    if (strlen(name) != 75 || !lc_host_unhex(name + 11, configuration, 32) ||
        !lc_host_reauthorization_seal_read(approval, configuration, &seal, &present) || !present ||
        (memcmp(configuration, approval->manifest_sha256, 32) && seal.phase != LC_HOST_REAUTHORIZATION_READY)) return false;
    if (!memcmp(configuration, approval->manifest_sha256, 32)) return true; /* Exclude our changing deny receipt from its history commitment. */
    memcpy(digest, seal.digest, 32);
  } else return false; /* Unknown, orphan .next and unsupported records retain custody. */
  CC_SHA256_Update(&query->digest, name, (CC_LONG)strlen(name) + 1); CC_SHA256_Update(&query->digest, digest, 32);
  return true;
}
static inline bool lc_host_reauthorization_begin(int state, lc_host_approval *approval, lc_host_reauthorization *query,
    bool (*qualification_entry)(int, const lc_host_approval *, const char *, unsigned char [32])) {
  if (query->used) return !query->blocked;
  memset(query, 0, sizeof(*query)); query->used = true; query->approval = approval;
  query->qualification_entry = qualification_entry;
  /* Set the in-memory deny gate first. Failure to persist is sticky; no future
   * request in this daemon can resume creators by reading uncertain bytes. */
  approval->reauthorization_sealed = true;
  query->receipt.actor = approval->actor; query->receipt.phase = LC_HOST_REAUTHORIZATION_PENDING;
  query->receipt.namespace = approval->writer_namespace;
  strcpy(query->receipt.generation, approval->generation); memcpy(query->receipt.configuration_sha256, approval->manifest_sha256, 32);
  if (!lc_host_boot(query->receipt.boot) || !lc_host_unhex(approval->policy, query->receipt.policy_sha256, 32) ||
      !lc_host_unhex(approval->policy_generation, query->receipt.policy_generation, 32) ||
      !lc_host_reauthorization_store(state, approval, &query->receipt)) { query->blocked = true; return false; }
  return true;
}
static inline void lc_host_reauthorization_tick(int state, lc_host_reauthorization *query, bool originals_closed) {
  if (!query->used || query->blocked || query->ready || !originals_closed) return;
  if (query->principal_index < query->approval->principal_count) {
    if (!lc_host_principal_valid(&query->approval->principals[query->principal_index])) query->blocked = true;
    else query->principal_index++;
    return;
  }
  if (!query->scanning) {
    unsigned char zero[32] = {0};
    if (!lc_host_scan_begin(state, query->approval->actor, zero, &query->history)) { query->blocked = true; return; }
    query->history.observe = lc_host_reauthorization_observe; query->history.observation = query;
    if (!lc_host_reauthorization_observe(state, NULL, query)) { query->blocked = true; return; }
    query->scanning = true;
  }
  uint64_t start, now;
  if (!lc_host_monotonic(&start)) { query->blocked = true; return; }
  for (size_t i = 0; i < 8 && query->history.phase == LC_HOST_SCAN_PENDING; i++) {
    if (!lc_host_monotonic(&now) || now - start >= 2) return;
    lc_host_scan_step(state, &query->history);
  }
  if (query->history.phase == LC_HOST_SCAN_PENDING) return;
  if (query->history.phase != LC_HOST_SCAN_COMPLETE || query->history.unsettled ||
      query->setup_resource_count != query->receipt.permit_count ||
      memcmp(query->setup_resource_keys, query->consumed_resource_keys, 32)) { query->blocked = true; return; }
  /* No original callback can create after the durable seal. The immutable
   * retired records, not a fresh lock query, establish clean setup admission. */
  CC_SHA256_Final(query->receipt.history_sha256, &query->digest);
  query->receipt.phase = LC_HOST_REAUTHORIZATION_READY;
  if (!lc_host_reauthorization_store(state, query->approval, &query->receipt)) { query->blocked = true; return; }
  query->ready = true;
}
#endif
