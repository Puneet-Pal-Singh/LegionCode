#ifndef LEGIONCODE_HOST_RECORD_H
#define LEGIONCODE_HOST_RECORD_H
#include "legioncode-host-principal.h"
#include "legioncode-host-wire.h"
#include "legioncode-host-metadata.h"
#include <stddef.h>
#include <dirent.h>

typedef enum { LC_HOST_IDLE = 1, LC_HOST_PREPARED, LC_HOST_RUNNING, LC_HOST_CLOSING,
               LC_HOST_CLOSED, LC_HOST_UNKNOWN } lc_host_phase;
typedef struct {
  LC_HOST_RESOURCE_PREFIX_FIELDS;
  lc_host_principal principal;
  lc_host_metadata metadata;
  unsigned char setup_nonce[32], setup_manifest_sha256[32];
  uint32_t setup_metadata_started, setup_metadata_inspected;
  char root_path[PATH_MAX], namespace_path[PATH_MAX], work_path[PATH_MAX];
  unsigned char command_ids[256][32];
  _Alignas(8) unsigned char digest[32];
} lc_host_scope_record;
_Static_assert(offsetof(lc_host_scope_record, principal) == sizeof(lc_host_resource_record_prefix), "Protected resource prefix ABI");
_Static_assert(offsetof(lc_host_scope_record, digest) + 32 == sizeof(lc_host_scope_record), "Protected digest covers the complete record body");

static inline bool lc_host_boot_field(const char boot[40]) {
  if (boot[36] || boot[37] || boot[38] || boot[39]) return false;
  for (unsigned int i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (boot[i] != '-') return false; }
    else if (!((boot[i] >= '0' && boot[i] <= '9') || (boot[i] >= 'a' && boot[i] <= 'f'))) return false;
  }
  return true;
}
static inline bool lc_host_boot(char out[40]) {
  size_t size = 40; memset(out, 0, 40);
  if (sysctlbyname("kern.bootsessionuuid", out, &size, NULL, 0) || size != 37) return false;
  for (unsigned int i = 0; i < 36; i++) if (out[i] >= 'A' && out[i] <= 'F') out[i] += 'a' - 'A';
  return lc_host_boot_field(out);
}
static inline bool lc_host_record_digest(lc_host_scope_record *record, bool verify) {
  unsigned char hash[32];
  CC_SHA256(record, (CC_LONG)offsetof(lc_host_scope_record, digest), hash);
  if (verify) return !memcmp(record->digest, hash, sizeof(hash));
  memcpy(record->digest, hash, sizeof(hash)); return true;
}
static inline bool lc_host_record_name(const char *name) {
  if (strlen(name) != 73 || strncmp(name, "resource.", 9)) return false;
  unsigned char hash[32]; return lc_host_unhex(name + 9, hash, sizeof(hash));
}
/* These records are privileged resource custody, not a product lifecycle log.
 * A hash detects incomplete/unsupported bytes; ROOT custody authorizes them. */
static inline bool lc_host_record_read(int state, const char *name, lc_host_scope_record *record) {
  char path[PATH_MAX]; struct stat st; memset(record, 0, sizeof(*record));
  if (!lc_host_record_name(name) || snprintf(path, sizeof(path), "%s/%s", LC_HOST_STATE, name) >= (int)sizeof(path)) return false;
  int fd = lc_host_open_protected(path, false);
  if (fd < 0) return false;
  bool okay = !fstat(fd, &st) && st.st_size == sizeof(*record) && lc_host_io(fd, record, sizeof(*record), false);
  if (close(fd)) okay = false;
  unsigned char capability[32], receipt = 0, guid = 0, nonce = 0, manifest = 0;
  for (size_t i = 0; i < sizeof(record->cleanup_receipt); i++) receipt |= record->cleanup_receipt[i];
  for (size_t i = 0; i < sizeof(record->principal.guid); i++) guid |= record->principal.guid[i];
  for (size_t i = 0; i < 32; i++) { nonce |= record->setup_nonce[i]; manifest |= record->setup_manifest_sha256[i]; }
  if (!okay || record->version != LC_HOST_RESOURCE_RECORD_VERSION || record->bytes != sizeof(*record) ||
      record->digest_offset != offsetof(lc_host_scope_record, digest) ||
      (record->purpose != LC_HOST_RESOURCE_NATIVE && record->purpose != LC_HOST_RESOURCE_SETUP_QUALIFICATION) ||
      (record->purpose == LC_HOST_RESOURCE_NATIVE ? nonce || manifest || record->setup_metadata_started || record->setup_metadata_inspected : !nonce || !manifest || record->setup_metadata_started > 1 || record->setup_metadata_inspected > 1 || (record->setup_metadata_inspected && !record->setup_metadata_started)) ||
      (record->purpose == LC_HOST_RESOURCE_SETUP_QUALIFICATION && !record->setup_metadata_inspected &&
        ((record->phase != LC_HOST_IDLE && record->phase != LC_HOST_UNKNOWN && record->phase != LC_HOST_CLOSING) || record->command_count || record->cleanup_closed)) ||
      record->phase < LC_HOST_IDLE || record->phase > LC_HOST_UNKNOWN || record->command_count > 256 ||
      record->cleanup_closed > 1 || (record->cleanup_closed && (record->phase != LC_HOST_CLOSED || !receipt)) ||
      (!record->cleanup_closed && receipt) || !guid || record->binding.reserved ||
      !record->binding.actor_uid || record->principal.uid <= 501 || record->principal.gid <= 501 ||
      record->binding.actor_uid == record->principal.uid ||
      !memchr(record->root_path, 0, sizeof(record->root_path)) ||
      !memchr(record->namespace_path, 0, sizeof(record->namespace_path)) ||
      !memchr(record->work_path, 0, sizeof(record->work_path)) ||
      !memchr(record->origin_generation, 0, sizeof(record->origin_generation)) ||
      !lc_host_unhex(record->origin_generation, capability, 32) ||
      !lc_host_boot_field(record->boot) ||
      !lc_host_record_digest(record, true) ||
      ((record->purpose == LC_HOST_RESOURCE_NATIVE || record->setup_metadata_inspected) && !lc_host_metadata_record_valid(&record->metadata)) || !lc_host_unhex(name + 9, capability, 32) ||
      memcmp(capability, record->binding.capability_sha256, 32) || record->binding.abi != LC_HOST_ABI ||
      record->binding.execution_uid != record->principal.uid ||
      memcmp(record->binding.principal_guid, record->principal.guid, 16)) return false;
  struct stat held, current;
  return !fstat(state, &held) && !lstat(LC_HOST_STATE, &current) &&
    held.st_dev == current.st_dev && held.st_ino == current.st_ino;
}
/* Scan disk, including retired slots. Unreadable/partial records block new UID
 * provisioning; they cannot be skipped to manufacture a fresh attempt. */
static inline bool lc_host_record_find(int state, uid_t actor, const unsigned char scope[32],
    lc_host_scope_record *found, char name[80], bool *present) {
  int independent = openat(state, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat held, scan;
  if (independent < 0) return false;
  if (fstat(state, &held) || fstat(independent, &scan) || held.st_dev != scan.st_dev || held.st_ino != scan.st_ino) { close(independent); return false; }
  DIR *directory = fdopendir(independent); if (!directory) { close(independent); return false; }
  bool okay = true; size_t count = 0; *present = false;
  for (;;) {
    errno = 0; struct dirent *entry = readdir(directory);
    if (!entry) { if (errno) okay = false; break; }
    if (strncmp(entry->d_name, "resource.", 9)) continue;
    size_t length = strlen(entry->d_name);
    if (length == 80 && !strcmp(entry->d_name + 73, ".access")) {
      char owner[80]; memcpy(owner, entry->d_name, 73); owner[73] = 0;
      lc_host_scope_record owner_record;
      if (!lc_host_record_read(state, owner, &owner_record)) { okay = false; break; }
      continue;
    }
    lc_host_scope_record record;
    if (++count > LC_HOST_MAX_PRINCIPALS || !lc_host_record_read(state, entry->d_name, &record)) { okay = false; break; }
    if (record.binding.actor_uid != actor || memcmp(record.binding.scope_sha256, scope, 32)) continue;
    if (*present) { okay = false; break; }
    *present = true; *found = record; strcpy(name, entry->d_name);
  }
  if (closedir(directory)) okay = false; return okay;
}
static inline bool lc_host_request_scope(xpc_object_t request, unsigned char out[32]) {
  CC_SHA256_CTX digest; CC_SHA256_Init(&digest);
  for (const char **field = (const char *[]){ "workspaceId", "threadId", "runId", "turnId", "runAttemptId", NULL }; *field; field++) {
    char id[257]; if (!lc_host_get(request, *field, id, sizeof(id)) || !id[0]) return false;
    for (const unsigned char *p = (const unsigned char *)id; *p; p++) if (*p < 33 || *p > 126) return false;
    CC_SHA256_Update(&digest, id, (CC_LONG)strlen(id) + 1);
  }
  CC_SHA256_Final(out, &digest); return true;
}
#endif
