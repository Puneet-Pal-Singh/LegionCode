/* Private privileged adapter for the existing physical-writer WAL.
 *
 * This is linked only into the approved root broker. Its caller must already
 * have authenticated the installed bridge, received the ORIGINAL borrowed
 * descriptors from the physical writer and validated its protected principal
 * reservation, resource generation and creator/cleanup gate. Neither a lock
 * query nor actor-writable WAL bytes establish that provenance.
 *
 * The three host-resource entry points do not acquire/unlock a writer, signal
 * a process, restore access, release a descriptor or settle a Turn. The separate
 * setup acquisition entry below delegates ONLY to the canonical actor codec.
 * In particular, host-resource complete() is
 * called only AFTER independent UID/control/pipe/access closure. It discharges
 * the exact UID/access obligation, leaving child and host obligations intact.
 */
#define _DARWIN_C_SOURCE 1
#define LC_HOST_WRITER_PROVIDER 1
#include "legioncode-host-writer-contract.h"
#include "legioncode-child-intent.h"
#include "legioncode-host-setup-contract.h"

#if defined(__APPLE__)
#include <inttypes.h>
#include <stdio.h>

typedef struct {
  lc_child_intent header;
  unsigned char binding[32], reservation[32];
} lc_host_wal_scope;

static bool nonzero(const unsigned char *bytes, size_t size) {
  unsigned char value = 0;
  for (size_t i = 0; i < size; ++i) value |= bytes[i];
  return value != 0;
}

static bool same_file(const struct stat *file, lc_host_file_identity expected) {
  return (uint64_t)file->st_dev == expected.device &&
    (uint64_t)file->st_ino == expected.inode;
}

/* An explicit encoding avoids native padding/byte order in durable digests. */
static bool encode_binding(const lc_host_writer_binding *binding, unsigned char bytes[272]) {
  if (!binding || binding->abi != 1 || binding->reserved ||
      binding->actor_uid < 501 || binding->actor_uid == UINT32_MAX ||
      binding->execution_uid <= 501 || binding->execution_uid == UINT32_MAX ||
      binding->actor_uid == binding->execution_uid ||
      !binding->root.inode || !binding->namespace.inode || !binding->fence.inode ||
      !nonzero(binding->principal_guid, 16) || !nonzero(binding->scope_sha256, 32) ||
      !nonzero(binding->capability_sha256, 32) || !nonzero(binding->policy_sha256, 32) ||
      !nonzero(binding->resource_id, 32) || !nonzero(binding->broker_resource_generation, 32) ||
      !nonzero(binding->approved_policy_generation, 32)) return false;
  lc_put32(bytes, binding->abi); lc_put32(bytes + 4, binding->actor_uid);
  lc_put32(bytes + 8, binding->execution_uid); lc_put32(bytes + 12, 0);
  lc_put64(bytes + 16, binding->root.device); lc_put64(bytes + 24, binding->root.inode);
  lc_put64(bytes + 32, binding->namespace.device); lc_put64(bytes + 40, binding->namespace.inode);
  lc_put64(bytes + 48, binding->fence.device); lc_put64(bytes + 56, binding->fence.inode);
  memcpy(bytes + 64, binding->principal_guid, 16);
  memcpy(bytes + 80, binding->scope_sha256, 32);
  memcpy(bytes + 112, binding->capability_sha256, 32);
  memcpy(bytes + 144, binding->policy_sha256, 32);
  memcpy(bytes + 176, binding->resource_id, 32);
  memcpy(bytes + 208, binding->broker_resource_generation, 32);
  memcpy(bytes + 240, binding->approved_policy_generation, 32);
  return true;
}

static bool digest_scope(const unsigned char bytes[272], lc_host_wal_scope *scope) {
  static const unsigned char binding_domain[] = "LegionCode/host-writer-binding/v1";
  static const unsigned char reservation_domain[] = "LegionCode/host-uid-reservation/v1";
  CC_SHA256_CTX hash;
  if (!CC_SHA256_Init(&hash) || !CC_SHA256_Update(&hash, binding_domain, sizeof(binding_domain)) ||
      !CC_SHA256_Update(&hash, bytes, 272) || !CC_SHA256_Final(scope->binding, &hash)) return false;
  if (!CC_SHA256_Init(&hash) || !CC_SHA256_Update(&hash, reservation_domain, sizeof(reservation_domain)) ||
      !CC_SHA256_Update(&hash, bytes, 272) || !CC_SHA256_Final(scope->reservation, &hash)) return false;
  return true;
}

static bool original_scope(int fence, int root, int directory,
                           const lc_host_writer_binding *binding, lc_host_wal_scope *scope) {
  unsigned char bytes[272]; struct stat workspace, namespace, file, named;
  if (getuid() != 0 || geteuid() != 0 || !encode_binding(binding, bytes) ||
      fstat(root, &workspace) || !S_ISDIR(workspace.st_mode) || workspace.st_uid != binding->actor_uid ||
      !same_file(&workspace, binding->root) ||
      fstat(directory, &namespace) || !S_ISDIR(namespace.st_mode) || namespace.st_uid != binding->actor_uid ||
      (namespace.st_mode & 0777) != 0700 || !same_file(&namespace, binding->namespace) ||
      fstat(fence, &file) || !S_ISREG(file.st_mode) || file.st_uid != binding->actor_uid ||
      (file.st_mode & 0777) != 0600 || file.st_nlink != 1 || !same_file(&file, binding->fence)) return false;
  int flags = fcntl(fence, F_GETFL);
  if (flags < 0 || (flags & O_ACCMODE) != O_RDWR || (flags & O_APPEND)) return false;
  char name[64];
  int length = snprintf(name, sizeof(name), "%" PRIx64 "-%" PRIx64 ".lease",
    binding->root.device, binding->root.inode);
  if (length <= 0 || length >= (int)sizeof(name) ||
      fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) || !S_ISREG(named.st_mode) ||
      !same_file(&named, binding->fence) || named.st_nlink != 1 ||
      named.st_uid != binding->actor_uid || (named.st_mode & 0777) != 0600) return false;
  /* Do not use lc_borrowed_header: its ordinary actor path acquires byte0.
   * The root broker only borrows the already-owned original description. */
  if (!lc_io(fence, scope->header.bytes, sizeof(scope->header.bytes), 0, false) ||
      !lc_record_valid(&scope->header, 1) || scope->header.bytes[8] != 'H' ||
      lc_get64(scope->header.bytes + 24) != binding->root.device ||
      lc_get64(scope->header.bytes + 32) != binding->root.inode ||
      lc_get64(scope->header.bytes + 40) != binding->namespace.device ||
      lc_get64(scope->header.bytes + 48) != binding->namespace.inode ||
      lc_get64(scope->header.bytes + 56) != binding->fence.device ||
      lc_get64(scope->header.bytes + 64) != binding->fence.inode) return false;
  return digest_scope(bytes, scope);
}

#include "legioncode-host-setup-writer.h"

/* Resolve only an exact immutable U record. The canonical codec subsequently
 * revalidates it under its own byte1 serializer before asserting/completing it.
 * No newly read record supplies privileged cleanup authority. */
static bool find_resource(int fence, const lc_host_writer_binding *binding,
                          const lc_host_wal_scope *scope, lc_child_intent *intent) {
  uint64_t now;
  if (!lc_clock(&now)) return false;
  uint64_t deadline = now + 4000;
  if (!lc_journal_lock(fence, deadline, false)) return false;
  lc_intent_log log; bool found = false, okay = false;
  if (!lc_log_read(fence, &log, false)) goto unlock;
  if (!lc_host_log_binding(fence, &scope->header, &log, binding->actor_uid)) goto out;
  for (size_t i = 1; i < log.count; ++i) {
    const lc_child_intent *record = &log.intents[i];
    if (record->bytes[8] != 'U' || lc_get32(record->bytes + 112) != binding->actor_uid ||
        lc_get32(record->bytes + 116) != binding->execution_uid ||
        memcmp(record->bytes + 128, scope->binding, 32) ||
        memcmp(record->bytes + 160, scope->reservation, 32) ||
        memcmp(record->bytes + 192, binding->capability_sha256, 32)) continue;
    if (found) goto out;
    *intent = *record; found = true;
  }
  okay = found;
out:
  lc_log_free(&log);
unlock:
  if (!lc_journal_lock(fence, deadline, true)) okay = false;
  return okay;
}

bool lc_writer_host_resource_prepare(int fence, int root, int directory,
                                     const lc_host_writer_binding *binding) {
  lc_host_wal_scope scope; lc_child_intent intent;
  return original_scope(fence, root, directory, binding, &scope) &&
    lc_host_resource_begin(fence, &scope.header, binding->actor_uid, binding->execution_uid,
      scope.binding, scope.reservation, binding->capability_sha256, &intent);
}

bool lc_writer_host_resource_assert(int fence, int root, int directory,
                                    const lc_host_writer_binding *binding) {
  lc_host_wal_scope scope; lc_child_intent intent;
  return original_scope(fence, root, directory, binding, &scope) &&
    find_resource(fence, binding, &scope, &intent) && lc_host_resource_assert(fence, &scope.header, &intent);
}

bool lc_writer_host_resource_complete(int fence, int root, int directory,
                                      const lc_host_writer_binding *binding) {
  lc_host_wal_scope scope; lc_child_intent intent;
  return original_scope(fence, root, directory, binding, &scope) &&
    find_resource(fence, binding, &scope, &intent) && lc_host_resource_complete(fence, &scope.header, &intent);
}
#else
bool lc_writer_host_resource_prepare(int fence, int root, int directory, const lc_host_writer_binding *binding) {
  (void)fence; (void)root; (void)directory; (void)binding; return false;
}
bool lc_writer_host_resource_assert(int fence, int root, int directory, const lc_host_writer_binding *binding) {
  (void)fence; (void)root; (void)directory; (void)binding; return false;
}
bool lc_writer_host_resource_complete(int fence, int root, int directory, const lc_host_writer_binding *binding) {
  (void)fence; (void)root; (void)directory; (void)binding; return false;
}
#endif
