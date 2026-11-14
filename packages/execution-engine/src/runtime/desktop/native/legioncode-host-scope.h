#ifndef LEGIONCODE_HOST_SCOPE_H
#define LEGIONCODE_HOST_SCOPE_H
#include "legioncode-host-access.h"
#include "legioncode-host-sandbox.h"
#include "legioncode-host-wire.h"
#include "legioncode-host-qualification-toolchain.h"

#include "legioncode-host-record.h"

typedef struct {
  bool used, sealed, released, owner_disconnected, retirement_unknown, launch_closed, stdout_closed, stderr_closed, access_ready;
  lc_host_scope_record record;
  const lc_host_approval *approval; int state_directory;
  char capability[65], command_id[257], command_digest[65], name[80];
  int root, namespace, fence, work, journal, stdout_fd, stderr_fd;
  pid_t child, signaler;
  int wait_status; bool reaped, child_identity_lost, signaler_identity_lost, timed_out, truncated;
  uint64_t deadline, next_signal;
  unsigned char stdout_bytes[LC_HOST_MAX_OUTPUT], stderr_bytes[LC_HOST_MAX_OUTPUT];
  size_t stdout_size, stderr_size;
  lc_host_bootstrap bootstrap;
  lc_host_access access;
  lc_host_metadata_pins metadata_pins;
} lc_host_scope;

static inline bool lc_host_scope_save(int state, lc_host_scope *scope) {
  char temporary[96]; snprintf(temporary, sizeof(temporary), "%s.next", scope->name);
  scope->record.bytes = sizeof(scope->record);
  scope->record.digest_offset = offsetof(lc_host_scope_record, digest);
  if (!lc_host_record_digest(&scope->record, false)) return false;
  int fd = openat(state, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  bool okay = lc_host_io(fd, &scope->record, sizeof(scope->record), true) && lc_host_sync(fd);
  if (close(fd)) okay = false;
  if (okay) okay = !renameat(state, temporary, state, scope->name) && lc_host_sync(state);
  /* A failed/partial record is preserved for explicit recovery, never deleted
   * to make a later writer look clean. */
  return okay;
}
static inline bool lc_host_scope_current(lc_host_scope *scope) {
  lc_host_file_identity root, namespace, fence;
  return scope->used && !scope->released && scope->approval &&
    lc_host_reservation_current(scope->state_directory, scope->approval, &scope->record.binding, scope->record.uid_slot_generation) && lc_host_identity(scope->root, true, &root) &&
    lc_host_identity(scope->namespace, true, &namespace) && lc_host_identity(scope->fence, false, &fence) &&
    lc_host_same(namespace, scope->record.binding.namespace) && lc_host_same(root, scope->record.binding.root) &&
    lc_host_same(fence, scope->record.binding.fence) && lc_host_writer_supported() &&
    lc_writer_host_resource_assert(scope->fence, scope->root, scope->namespace, &scope->record.binding);
}
static inline bool lc_host_scope_path_current(lc_host_scope *scope) {
  struct stat path; char canonical[PATH_MAX];
  return !lstat(scope->record.root_path, &path) && S_ISDIR(path.st_mode) && !S_ISLNK(path.st_mode) &&
    (uint64_t)path.st_dev == scope->record.binding.root.device && (uint64_t)path.st_ino == scope->record.binding.root.inode &&
    realpath(scope->record.root_path, canonical) && !strcmp(canonical, scope->record.root_path);
}
static inline void lc_host_scope_unknown(int state, lc_host_scope *scope) {
  scope->record.cleanup_closed = 0; memset(scope->record.cleanup_receipt, 0, sizeof(scope->record.cleanup_receipt));
  scope->sealed = true; scope->record.phase = LC_HOST_UNKNOWN; (void)lc_host_scope_save(state, scope);
  /* Keep all real FDs and the original writer. No timeout/transport error is
   * evidence that the UID, pipes or changed access disappeared. */
}
static inline bool lc_host_scope_seal(int state, lc_host_scope *scope) {
  if (scope->record.phase == LC_HOST_UNKNOWN) return false;
  scope->sealed = true;
  if (scope->record.phase != LC_HOST_CLOSED) scope->record.phase = LC_HOST_CLOSING;
  if (!lc_host_scope_save(state, scope)) { lc_host_scope_unknown(state, scope); return false; }
  return true;
}
static inline bool lc_host_command_seen(lc_host_scope *scope, const char *id) {
  unsigned char digest[32]; CC_SHA256(id, (CC_LONG)strlen(id), digest);
  for (uint32_t i = 0; i < scope->record.command_count; i++) if (!memcmp(digest, scope->record.command_ids[i], 32)) return true;
  return false;
}
static inline bool lc_host_scope_open(int state, const lc_host_approval *approval, xpc_object_t request,
                                     lc_host_scope *scope, const lc_host_record_scan *history) {
  static const char *const fields[] = { "version", "operation", "generation", "workspaceId", "threadId", "runId",
    "turnId", "runAttemptId", "policy", "policyGeneration", "rootFd", "fenceFd", "namespaceFd", LC_HOST_METADATA_FIELDS };
  if (!lc_host_fields(request, fields, sizeof(fields) / sizeof(fields[0])) || !lc_host_writer_supported()) return false;
  char policy[65]; if (!lc_host_get(request, "policy", policy, sizeof(policy)) || strcmp(policy, approval->policy)) return false;
  char policy_generation[65];
  if (!lc_host_get(request, "policyGeneration", policy_generation, sizeof(policy_generation)) || strcmp(policy_generation, approval->policy_generation)) return false;
  memset(scope, 0, sizeof(*scope)); scope->root = scope->namespace = scope->fence = scope->work = scope->journal = -1;
  scope->stdout_fd = scope->stderr_fd = -1;
  scope->approval = approval; scope->state_directory = state;
  for (size_t i = 0; i < LC_HOST_METADATA_PATHS; i++) scope->metadata_pins.fd[i] = -1;
  scope->root = xpc_fd_dup(xpc_dictionary_get_value(request, "rootFd"));
  scope->fence = xpc_fd_dup(xpc_dictionary_get_value(request, "fenceFd"));
  scope->namespace = xpc_fd_dup(xpc_dictionary_get_value(request, "namespaceFd"));
  struct stat root, fence;
  if (scope->root < 0 || scope->fence < 0 || scope->namespace < 0 || fstat(scope->root, &root) || fstat(scope->fence, &fence) ||
      root.st_uid != approval->actor || fence.st_uid != approval->actor || (fence.st_mode & 0777) != 0600 ||
      !lc_host_identity(scope->root, true, &scope->record.binding.root) ||
      !lc_host_identity(scope->namespace, true, &scope->record.binding.namespace) ||
      !lc_host_identity(scope->fence, false, &scope->record.binding.fence) ||
      fcntl(scope->root, F_GETPATH, scope->record.root_path) || !lc_host_absolute(scope->record.root_path) ||
      fcntl(scope->namespace, F_GETPATH, scope->record.namespace_path) || !lc_host_absolute(scope->record.namespace_path) ||
      lc_host_beneath(scope->record.root_path, scope->record.namespace_path) ||
      lc_host_beneath(scope->record.namespace_path, scope->record.root_path)) goto unused;
  if (!lc_host_metadata_read(request, &scope->record.metadata) ||
      !lc_host_metadata_open(&scope->record.metadata, &scope->metadata_pins, scope->record.root_path, scope->root)) goto unused;
  bool reserved;
  if (!lc_host_request_scope(request, scope->record.binding.scope_sha256) || !history ||
      history->phase != LC_HOST_SCAN_COMPLETE || history->actor != approval->actor || history->present ||
      memcmp(history->scope, scope->record.binding.scope_sha256, 32) ||
      !lc_host_reservation_seen(state, approval, scope->record.binding.scope_sha256, &reserved) || reserved) goto unused;
  unsigned char capability[32]; arc4random_buf(capability, sizeof(capability));
  lc_host_hex(capability, sizeof(capability), scope->capability, sizeof(scope->capability));
  CC_SHA256(capability, sizeof(capability), scope->record.binding.capability_sha256);
  arc4random_buf(scope->record.binding.resource_id, 32); arc4random_buf(scope->record.binding.broker_resource_generation, 32);
  scope->record.binding.abi = LC_HOST_ABI; scope->record.binding.actor_uid = approval->actor;
  if (!lc_host_unhex(policy, scope->record.binding.policy_sha256, 32) ||
      !lc_host_unhex(policy_generation, scope->record.binding.approved_policy_generation, 32) ||
      !lc_host_reserve_principal(state, approval, &scope->record.binding, &scope->record.principal, &scope->record.uid_slot_generation)) goto unused;
  scope->record.version = LC_HOST_RESOURCE_RECORD_VERSION;
  scope->record.purpose = LC_HOST_RESOURCE_NATIVE; scope->record.phase = LC_HOST_IDLE;
  if (!lc_host_boot(scope->record.boot)) goto unused;
  strcpy(scope->record.origin_generation, approval->generation);
  scope->record.binding.abi = LC_HOST_ABI; scope->record.binding.actor_uid = approval->actor;
  scope->record.binding.execution_uid = scope->record.principal.uid;
  memcpy(scope->record.binding.principal_guid, scope->record.principal.guid, 16);
  char cap_digest[65]; lc_host_hex(scope->record.binding.capability_sha256, 32, cap_digest, sizeof(cap_digest));
  snprintf(scope->name, sizeof(scope->name), "resource.%s", cap_digest);
  scope->used = true;
  if (!lc_host_scope_save(state, scope) ||
      !lc_writer_host_resource_prepare(scope->fence, scope->root, scope->namespace, &scope->record.binding)) {
    lc_host_scope_unknown(state, scope); return false;
  }
  int work_parent = lc_host_open_protected(LC_HOST_WORK, true); char directory[64];
  snprintf(directory, sizeof(directory), "uid.%u.%llu", scope->record.principal.uid, (unsigned long long)scope->record.uid_slot_generation);
  if (work_parent < 0) { lc_host_scope_unknown(state, scope); return false; }
  bool created = !mkdirat(work_parent, directory, 0700) && !fchownat(work_parent, directory,
    scope->record.principal.uid, scope->record.principal.gid, AT_SYMLINK_NOFOLLOW) && lc_host_sync(work_parent);
  scope->work = created ? openat(work_parent, directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) : -1;
  int original_parent = work_parent; work_parent = -1;
  if (close(original_parent)) { lc_host_scope_unknown(state, scope); return false; }
  if (scope->work < 0 || snprintf(scope->record.work_path, sizeof(scope->record.work_path), "%s/%s", LC_HOST_WORK, directory) >= (int)sizeof(scope->record.work_path)) {
    lc_host_scope_unknown(state, scope); return false;
  }
  if (lc_host_beneath(scope->record.work_path, scope->record.namespace_path) ||
      lc_host_beneath(scope->record.namespace_path, scope->record.work_path) ||
      lc_host_beneath(scope->record.root_path, scope->record.work_path) ||
      lc_host_beneath(scope->record.work_path, scope->record.root_path)) { lc_host_scope_unknown(state, scope); return false; }
  char journal[96]; snprintf(journal, sizeof(journal), "%s.access", scope->name);
  scope->journal = openat(state, journal, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  struct passwd actor, *found = NULL; char user[16384];
  if (scope->journal < 0 || getpwuid_r(approval->actor, &actor, user, sizeof(user), &found) || !found ||
      !lc_host_scope_save(state, scope)) { lc_host_scope_unknown(state, scope); return false; }
  scope->access.actor = approval->actor; scope->access.actor_gid = actor.pw_gid;
  scope->access.principal = scope->record.principal; scope->access.journal = scope->journal;
  scope->access.root_path = scope->record.root_path; scope->access.executables = approval->executables;
  scope->access.root_device = scope->record.binding.root.device;
  scope->access.metadata = &scope->record.metadata; scope->access.metadata_pins = &scope->metadata_pins;
  return true;
unused:
  for (size_t i = 0; i < LC_HOST_METADATA_PATHS; i++) if (scope->metadata_pins.fd[i] >= 0) close(scope->metadata_pins.fd[i]);
  if (scope->root >= 0) close(scope->root); if (scope->fence >= 0) close(scope->fence); if (scope->namespace >= 0) close(scope->namespace);
  scope->root = scope->fence = scope->namespace = -1; return false;
}

static inline bool lc_host_prepare_command_internal(int state, const lc_host_approval *approval,
    lc_host_scope *scope, xpc_object_t request, lc_host_resource_purpose purpose) {
  static const char *const fields[] = { "version", "operation", "generation", "capability", "commandId", "command", "cwd", LC_HOST_METADATA_FIELDS };
  char id[257], command[501], cwd[512]; lc_host_metadata metadata;
  if (scope->record.purpose != purpose ||
      (purpose != LC_HOST_RESOURCE_NATIVE && purpose != LC_HOST_RESOURCE_SETUP_QUALIFICATION) ||
      !lc_host_fields(request, fields, sizeof(fields) / sizeof(fields[0])) || scope->sealed ||
      scope->record.phase != LC_HOST_IDLE || scope->record.command_count >= 256 || !lc_host_scope_current(scope) || !lc_host_scope_path_current(scope) ||
      !lc_host_uid_zero(scope->record.principal.uid) || !lc_host_get(request, "commandId", id, sizeof(id)) ||
      lc_host_command_seen(scope, id) || !lc_host_get(request, "command", command, sizeof(command)) ||
      !lc_host_get(request, "cwd", cwd, sizeof(cwd)) || !lc_host_metadata_read(request, &metadata) ||
      memcmp(metadata.digest, scope->record.metadata.digest, 32) ||
      !lc_host_metadata_current(&scope->record.metadata, &scope->metadata_pins) ||
      !lc_host_metadata_receipt_matches(&scope->record.metadata, &scope->metadata_pins, scope->root)) return false;
  /* Validate disjoint protected namespaces and the actual policy before the
   * first ACE is changed, not only immediately before target execution. */
  lc_host_policy_buffer policy;
  if (!lc_host_build_policy(approval, scope->record.root_path, scope->record.work_path, &scope->record.metadata, &policy)) return false;
  lc_host_bootstrap *bootstrap = &scope->bootstrap; memset(bootstrap, 0, sizeof(*bootstrap));
  bootstrap->magic = LC_HOST_BOOTSTRAP_MAGIC; bootstrap->uid = scope->record.principal.uid;
  bootstrap->gid = scope->record.principal.gid; bootstrap->root = scope->record.binding.root; bootstrap->fence = scope->record.binding.fence;
  strcpy(bootstrap->command, command); strcpy(bootstrap->cwd, cwd); strcpy(bootstrap->work, scope->record.work_path);
  /* Capture ONLY the protected approved Node/npm/env/bash role directories.
   * The launcher environment below is private to sandbox-exec; target commands
   * receive this exact path after sandbox, credential drop and descriptor close. */
  if (!lc_host_command_path(approval, bootstrap->path, sizeof(bootstrap->path))) return false;
  CC_SHA256_CTX digest; unsigned char hash[32]; CC_SHA256_Init(&digest);
  CC_SHA256_Update(&digest, command, (CC_LONG)strlen(command) + 1); CC_SHA256_Update(&digest, cwd, (CC_LONG)strlen(cwd) + 1);
  CC_SHA256_Final(hash, &digest); lc_host_hex(hash, sizeof(hash), scope->command_digest, sizeof(scope->command_digest));
  strcpy(scope->command_id, id); CC_SHA256(id, (CC_LONG)strlen(id), scope->record.command_ids[scope->record.command_count++]);
  scope->record.phase = LC_HOST_PREPARED;
  scope->child = 0; scope->reaped = false; scope->stdout_closed = scope->stderr_closed = true;
  scope->stdout_size = scope->stderr_size = 0; scope->timed_out = scope->truncated = false;
  if (!lc_host_scope_save(state, scope)) { lc_host_scope_unknown(state, scope); return false; }
  scope->access_ready = false;
  if (!lc_host_access_prepare(&scope->access, scope->root, scope->record.root_path)) {
    /* Some ACEs may already exist; keep the writer until exact restoration. */
    (void)lc_host_scope_seal(state, scope); return false;
  }
  scope->access_ready = true; return true;
}

/* External requests retain Native-only admission. The private setup runner may
 * call the same implementation ONLY with its fixed internal recipe objects. */
static inline bool lc_host_prepare_command(int state, const lc_host_approval *approval,
    lc_host_scope *scope, xpc_object_t request) {
  return lc_host_prepare_command_internal(state, approval, scope, request, LC_HOST_RESOURCE_NATIVE);
}

static inline bool lc_host_pipe(int pair[2]) {
  if (pipe(pair)) return false;
  if (fcntl(pair[0], F_SETFD, FD_CLOEXEC) || fcntl(pair[1], F_SETFD, FD_CLOEXEC)) return false;
  return true;
}
static inline bool lc_host_launch_close(int *descriptor) {
  int original = *descriptor; *descriptor = -1;
  return original >= 0 && close(original) == 0;
}
static inline bool lc_host_release_command_internal(int state, const lc_host_approval *approval, lc_host_scope *scope, lc_host_resource_purpose purpose) {
  if (scope->record.purpose != purpose ||
      (purpose != LC_HOST_RESOURCE_NATIVE && purpose != LC_HOST_RESOURCE_SETUP_QUALIFICATION) || scope->sealed || scope->record.phase != LC_HOST_PREPARED || !scope->access_ready || !lc_host_scope_current(scope) || !lc_host_scope_path_current(scope) ||
      !lc_host_metadata_current(&scope->record.metadata, &scope->metadata_pins) ||
      !lc_host_metadata_receipt_matches(&scope->record.metadata, &scope->metadata_pins, scope->root)) return false;
  lc_host_policy_buffer policy;
  CFArrayRef verified_executables;
  if (!lc_host_installed_broker_valid(approval) || !lc_host_paths(approval->executables, &verified_executables, true) ||
      !lc_host_build_policy(approval, scope->record.root_path, scope->record.work_path, &scope->record.metadata, &policy)) return false;
  scope->launch_closed = false;
  int output[2] = {-1,-1}, error[2] = {-1,-1}, payload[2] = {-1,-1};
  if (!lc_host_pipe(output) || !lc_host_pipe(error) || !lc_host_pipe(payload)) goto failed;
  int root = fcntl(scope->root, F_DUPFD_CLOEXEC, 20), fence = fcntl(scope->fence, F_DUPFD_CLOEXEC, 20);
  int input = fcntl(payload[0], F_DUPFD_CLOEXEC, 20), out = fcntl(output[1], F_DUPFD_CLOEXEC, 20), err = fcntl(error[1], F_DUPFD_CLOEXEC, 20);
  if (root < 0 || fence < 0 || input < 0 || out < 0 || err < 0) {
    if(root>=0)close(root); if(fence>=0)close(fence); if(input>=0)close(input); if(out>=0)close(out); if(err>=0)close(err); goto failed;
  }
  scope->record.phase = LC_HOST_RUNNING;
  if (!lc_host_scope_save(state, scope) || !lc_host_monotonic(&scope->deadline)) {
    close(root); close(fence); close(input); close(out); close(err); goto failed;
  }
  scope->deadline += 60000; scope->next_signal = 0;
  scope->reaped = scope->child_identity_lost = scope->signaler_identity_lost = scope->timed_out = scope->truncated = false;
  scope->stdout_size = scope->stderr_size = 0; scope->stdout_closed = scope->stderr_closed = false;
  pid_t child = fork();
  if (child == 0) {
    int null = open("/dev/null", O_RDONLY | O_CLOEXEC); long maximum = sysconf(_SC_OPEN_MAX);
    if (null < 0 || maximum < 21 || maximum > INT_MAX || dup2(null, 0) < 0 || dup2(out, 1) < 0 || dup2(err, 2) < 0 ||
        dup2(root, 5) < 0 || dup2(fence, 6) < 0 || dup2(input, 8) < 0) _exit(126);
    for (int fd = 3; fd < maximum; fd++) if (fd != 5 && fd != 6 && fd != 8) {
      errno = 0; int flags = fcntl(fd, F_GETFD);
      if (flags < 0) { if (errno != EBADF) _exit(126); }
      else if (close(fd)) _exit(126);
    }
    char *argv[] = { "/usr/bin/sandbox-exec", "-p", policy.bytes, LC_HOST_INSTALLED_BROKER, "--bootstrap", NULL };
    char *env[] = { "PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", NULL };
    execve(argv[0], argv, env); _exit(127);
  }
  if (child > 0) scope->child = child;
  bool parent_closed = true;
  int *duplicates[] = { &root, &fence, &input, &out, &err };
  for (size_t i = 0; i < sizeof(duplicates) / sizeof(duplicates[0]); i++)
    if (!lc_host_launch_close(duplicates[i])) parent_closed = false;
  if (child < 0) goto failed;
  if (!lc_host_launch_close(&output[1])) parent_closed = false;
  if (!lc_host_launch_close(&error[1])) parent_closed = false;
  if (!lc_host_launch_close(&payload[0])) parent_closed = false;
  scope->stdout_fd = output[0]; output[0] = -1; scope->stderr_fd = error[0]; error[0] = -1;
  bool sent = !fcntl(scope->stdout_fd, F_SETFL, O_NONBLOCK) && !fcntl(scope->stderr_fd, F_SETFL, O_NONBLOCK) &&
    lc_host_io(payload[1], &scope->bootstrap, sizeof(scope->bootstrap), true);
  if (!lc_host_launch_close(&payload[1])) parent_closed = false;
  if (!sent || !parent_closed) { lc_host_scope_unknown(state, scope); return false; }
  scope->launch_closed = true; return true;
failed:
  for (int i = 0; i < 2; i++) {
    if (output[i] >= 0) (void)lc_host_launch_close(&output[i]);
    if (error[i] >= 0) (void)lc_host_launch_close(&error[i]);
    if (payload[i] >= 0) (void)lc_host_launch_close(&payload[i]);
  }
  lc_host_scope_unknown(state, scope); return false;
}

static inline bool lc_host_release_command(int state, const lc_host_approval *approval, lc_host_scope *scope) {
  return lc_host_release_command_internal(state, approval, scope, LC_HOST_RESOURCE_NATIVE);
}

static inline bool lc_host_drain(int *fd, unsigned char *bytes, size_t *size, bool *closed, bool *truncated) {
  if (*fd < 0) return *closed;
  int flags = fcntl(*fd, F_GETFL);
  if (flags < 0 || !(flags & O_NONBLOCK)) return false;
  uint64_t start, now;
  if (!lc_host_monotonic(&start)) return false;
  unsigned char chunk[8192];
  /* All scopes share the broker's control queue. A continuously writable pipe
   * must yield to Stop/deadline processing. Budget exhaustion is NOT EOF: retain
   * the read FD and continue on the next timer tick, including after UID kill. */
  for (unsigned int reads = 0; reads < 4; reads++) {
    if (!lc_host_monotonic(&now)) return false;
    if (now - start >= 2) return true;
    ssize_t n = read(*fd, chunk, sizeof(chunk));
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return true;
    if (n < 0) return false;
    if (!n) {
      int original = *fd; *fd = -1;
      /* A failed close is unknown, and its number may already be reusable.
       * Never revisit that number as though it still identified this pipe. */
      if (close(original)) return false;
      *closed = true; return true;
    }
    size_t keep = (size_t)n < LC_HOST_MAX_OUTPUT - *size ? (size_t)n : LC_HOST_MAX_OUTPUT - *size;
    if (keep) { memcpy(bytes + *size, chunk, keep); *size += keep; }
    if (keep != (size_t)n) *truncated = true;
  }
  return true;
}
static inline void lc_host_scope_tick(int state, lc_host_scope *scope) {
  if (!scope->used || scope->record.phase == LC_HOST_CLOSED) return;
  /* Setup before canonical G has no private-UID creator. Only its setup owner
   * may settle the original H/control child or the typed unexposed cancellation;
   * do not infer G/U/V/access cleanup from empty metadata. */
  if (scope->record.purpose == LC_HOST_RESOURCE_SETUP_QUALIFICATION && !scope->record.setup_metadata_inspected) return;
  /* A stale projection/late callback cannot signal or alter ACLs belonging to a
   * later generation, even if its numerical UID has since been reused. */
  if (!scope->approval || !lc_host_reservation_current(state, scope->approval,
      &scope->record.binding, scope->record.uid_slot_generation)) return;
  if (scope->record.phase == LC_HOST_IDLE && !scope->sealed) return;
  uint64_t now;
  if (!lc_host_monotonic(&now)) { lc_host_scope_unknown(state, scope); return; }
  if (scope->child && !scope->reaped && !scope->child_identity_lost) {
    pid_t observed = waitpid(scope->child, &scope->wait_status, WNOHANG);
    if (observed == scope->child) scope->reaped = true;
    else if (observed < 0 && errno != EINTR) { scope->child_identity_lost = true; lc_host_scope_unknown(state, scope); return; }
  }
  if (scope->signaler && !scope->signaler_identity_lost) {
    int status; pid_t done = waitpid(scope->signaler, &status, WNOHANG);
    if (done == scope->signaler) scope->signaler = 0;
    else if (done < 0 && errno != EINTR) { scope->signaler_identity_lost = true; lc_host_scope_unknown(state, scope); return; }
  }
  if ((scope->stdout_fd >= 0 && !lc_host_drain(&scope->stdout_fd, scope->stdout_bytes, &scope->stdout_size, &scope->stdout_closed, &scope->truncated)) ||
      (scope->stderr_fd >= 0 && !lc_host_drain(&scope->stderr_fd, scope->stderr_bytes, &scope->stderr_size, &scope->stderr_closed, &scope->truncated))) lc_host_scope_unknown(state, scope);
  if (scope->record.phase == LC_HOST_RUNNING && now >= scope->deadline) { scope->timed_out = true; (void)lc_host_scope_seal(state, scope); }
  bool cleanup = scope->sealed || (scope->child && scope->reaped);
  if (!cleanup) return;
  /* A pre-drop bootstrap is not yet represented by the UID census. Its exact
   * unreaped direct-child PID remains stable and must be reaped separately. */
  if (scope->child && !scope->reaped && !scope->child_identity_lost) (void)kill(scope->child, SIGKILL);
  if (!scope->signaler && now >= scope->next_signal && !lc_host_uid_zero(scope->record.principal.uid)) {
    scope->signaler = lc_host_signal_uid(&scope->record.principal, scope->fence, SIGKILL);
    if (scope->signaler < 0) { scope->signaler = 0; lc_host_scope_unknown(state, scope); return; }
    scope->next_signal = now + 100;
  }
  if ((scope->child && !scope->reaped) || scope->signaler || !lc_host_uid_zero(scope->record.principal.uid) ||
      (scope->child && (!scope->stdout_closed || !scope->stderr_closed))) return;
  if (scope->record.phase == LC_HOST_UNKNOWN) return;
  if ((scope->child && !scope->launch_closed) || scope->access.unknown) { lc_host_scope_unknown(state, scope); return; }
  /* No UID member remains and no command can be released during restoration. */
  if (scope->access.count && !lc_host_access_restore(&scope->access, scope->root)) { lc_host_scope_unknown(state, scope); return; }
  scope->access_ready = false;
  if (!scope->sealed) {
    scope->record.phase = LC_HOST_IDLE;
    if (!lc_host_scope_save(state, scope)) lc_host_scope_unknown(state, scope);
    return;
  }
  size_t count = 0;
  struct stat restored_work;
  if (!lc_host_restore_created(&scope->access, scope->work, 0, &count) ||
      fchown(scope->work, scope->access.actor, scope->access.actor_gid) || fstat(scope->work, &restored_work) ||
      restored_work.st_uid != scope->access.actor || restored_work.st_gid != scope->access.actor_gid || !lc_host_sync(scope->work) ||
      !lc_host_metadata_current(&scope->record.metadata, &scope->metadata_pins) ||
      !lc_host_metadata_receipt_matches(&scope->record.metadata, &scope->metadata_pins, scope->root) ||
      !lc_host_scope_current(scope) || !lc_writer_host_resource_complete(scope->fence, scope->root, scope->namespace, &scope->record.binding)) {
    lc_host_scope_unknown(state, scope); return;
  }
  scope->record.phase = LC_HOST_CLOSED;
  if (!lc_host_scope_save(state, scope)) { lc_host_scope_unknown(state, scope); return; }
  /* Last-close release still belongs to the original physical owner. Closing
   * these borrowed duplicates never explicitly unlocks its OFD fence. */
  bool closed = true;
  int *descriptors[] = { &scope->journal, &scope->work, &scope->root, &scope->namespace, &scope->fence };
  for (size_t i = 0; i < sizeof(descriptors) / sizeof(descriptors[0]); i++) {
    if (close(*descriptors[i])) closed = false; else *descriptors[i] = -1;
  }
  if (!closed) { lc_host_scope_unknown(state, scope); return; }
  for (size_t i = 0; i < LC_HOST_METADATA_PATHS; i++) if (scope->metadata_pins.fd[i] >= 0) {
    if (close(scope->metadata_pins.fd[i])) closed = false;
    scope->metadata_pins.fd[i] = -1;
  }
  if (!closed) { lc_host_scope_unknown(state, scope); return; }
  /* A CLOSED phase alone is not proof: receipt follows actual FD close. */
  scope->record.cleanup_closed = 1;
  arc4random_buf(scope->record.cleanup_receipt, sizeof(scope->record.cleanup_receipt));
  if (!lc_host_scope_save(state, scope)) { lc_host_scope_unknown(state, scope); return; }
  scope->released = true;
}
#endif
