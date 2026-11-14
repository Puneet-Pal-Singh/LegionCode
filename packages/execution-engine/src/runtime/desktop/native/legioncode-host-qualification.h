#ifndef LEGIONCODE_HOST_QUALIFICATION_H
#define LEGIONCODE_HOST_QUALIFICATION_H
#include "legioncode-host-setup-metadata.h"
#include "legioncode-host-qualification-fixture.h"
#include "legioncode-host-retirement.h"
#include "legioncode-host-qualification-cleanup.h"
#include <arpa/inet.h>
#include <sys/socket.h>

typedef enum {
  LC_QUAL_HISTORY = 1, LC_QUAL_ACQUIRE, LC_QUAL_METADATA, LC_QUAL_NETWORK_CONTROL,
  LC_QUAL_TEST, LC_QUAL_BUILD, LC_QUAL_FLOOD, LC_QUAL_CLOSING, LC_QUAL_BRIDGE,
  LC_QUAL_PASSED, LC_QUAL_CANCELLED, LC_QUAL_UNKNOWN,
} lc_host_qualification_phase;
enum { LC_QUAL_PARENT, LC_QUAL_ROOT_CLEANUP, LC_QUAL_WORK_CLEANUP, LC_QUAL_OUTSIDE,
  LC_QUAL_METADATA_CANARY, LC_QUAL_LISTENER, LC_QUAL_POSITIVE, LC_QUAL_ACCEPTED, LC_QUAL_FDS };
typedef struct {
  bool used, permit_consumed, cancel_requested, failed, bridge_confirmed, socket_positive, stop_observed, owner_releasable, original_peer_disconnected, unexposed;
  uint32_t phase, cleanup_target; size_t resource_index;
  lc_qualification_cleanup cleanup;
  unsigned char pass_receipt[32];
  char id[65], bridge_nonce[65], fixture[96], outside_name[96], fence_name[64];
  uint64_t deadline, flood_started;
  lc_host_scope *resource;
  xpc_object_t original_start;
  lc_host_record_scan history;
  lc_host_qualification_toolchain tools;
  lc_writer_setup_acquisition acquisition;
  lc_host_setup_metadata_execution metadata;
  int fd[LC_QUAL_FDS]; bool fd_closed[LC_QUAL_FDS], fd_close_attempted[LC_QUAL_FDS];
  lc_host_file_identity parent_identity, work_identity;
  uint16_t port; size_t positive_sent, positive_received;
  unsigned char positive_bytes[32], result_sha256[32], build_sha256[32], package_bin_sha256[32], core_utils_sha256[32], g_sha256[32];
  bool package_test, package_build, detached_observed, detached_closed;
  pid_t detached_pid; uint64_t detached_start_seconds, detached_start_microseconds;
} lc_host_qualification;

static inline bool lc_qualification_policy(const lc_host_approval *approval) {
  static const char prefix[] = "{\"domain\":\"LegionCode/native-host/sandbox-policy/v1\",\"recipeVersion\":1,\"ReadRoots\":[";
  static const char *const separators[] = { "],\"Executables\":[", "],\"ProtectedRoots\":[", "]}" };
  CFArrayRef arrays[] = { approval->reads, approval->executables, approval->protected_roots };
  CC_SHA256_CTX hash; CC_SHA256_Init(&hash); CC_SHA256_Update(&hash, prefix, sizeof(prefix) - 1);
  for (size_t i = 0; i < 3; i++) {
    for (CFIndex j = 0; j < CFArrayGetCount(arrays[i]); j++) {
      char path[PATH_MAX], encoded[PATH_MAX * 2];
      if (!lc_host_text(CFArrayGetValueAtIndex(arrays[i], j), path, sizeof(path)) || !lc_qualification_json(path, encoded, sizeof(encoded))) return false;
      if (j) CC_SHA256_Update(&hash, ",", 1);
      CC_SHA256_Update(&hash, encoded, (CC_LONG)strlen(encoded));
    }
    CC_SHA256_Update(&hash, separators[i], (CC_LONG)strlen(separators[i]));
  }
  unsigned char digest[32], expected[32]; CC_SHA256_Final(digest, &hash);
  return lc_host_unhex(approval->policy, expected, 32) && !memcmp(digest, expected, 32);
}
static inline bool lc_qualification_no_acl(int fd) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT;
  acl_entry_t entry; errno = 0; int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry); int error = errno;
  acl_free(acl); return result != 0 && error == EINVAL;
}

static inline bool lc_qualification_close(lc_host_qualification *job, size_t index) {
  if (job->fd_closed[index]) return true;
  int original = job->fd[index];
  if (original < 0 && !job->fd_close_attempted[index]) { job->fd_closed[index] = true; return true; }
  if (job->fd_close_attempted[index]) return false;
  job->fd[index] = -1; job->fd_close_attempted[index] = true;
  if (original < 0 || close(original)) return false;
  job->fd_closed[index] = true; return true;
}
static inline void lc_qualification_unknown(int state, lc_host_qualification *job) {
  job->phase = LC_QUAL_UNKNOWN; job->failed = true;
  lc_writer_setup_qualification_cancel(&job->acquisition);
  if (job->metadata.version) lc_host_setup_metadata_cancel(&job->metadata);
  if (job->resource && job->resource->used && job->permit_consumed && !job->resource->released)
    lc_host_scope_unknown(state, job->resource);
  /* No FD close/reopen, access repair, UID release, permit retry, or receipt
   * promotion on ambiguity. The original service retains physical custody. */
}
typedef struct {
  uint32_t version, bytes, purpose, actor;
  char boot[40], generation[65], permit[65], qualification_id[65];
  lc_host_file_identity namespace;
  unsigned char manifest_sha256[32], bridge_nonce[32];
  _Alignas(8) unsigned char digest[32];
} lc_host_setup_permit_consumption;
static inline bool lc_qualification_consume(int state, const lc_host_approval *approval, lc_host_qualification *job) {
  lc_host_setup_permit_consumption record; memset(&record, 0, sizeof(record));
  record.version = 1; record.bytes = sizeof(record); record.purpose = LC_HOST_RESOURCE_SETUP_QUALIFICATION; record.actor = approval->actor;
  strcpy(record.generation, approval->generation); strcpy(record.permit, approval->setup_permit_id); strcpy(record.qualification_id, job->id);
  if (!lc_host_boot(record.boot) || !lc_host_unhex(job->bridge_nonce, record.bridge_nonce, 32)) return false;
  record.namespace = approval->writer_namespace; memcpy(record.manifest_sha256, approval->manifest_sha256, 32);
  CC_SHA256(&record, (CC_LONG)offsetof(lc_host_setup_permit_consumption, digest), record.digest);
  char name[96]; snprintf(name, sizeof(name), "setup-permit.%s", approval->setup_permit_id);
  int fd = openat(state, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  /* Even a partial record consumes this permit. Never unlink it for retry. */
  job->permit_consumed = true;
  bool okay = lc_host_io(fd, &record, sizeof(record), true) && lc_host_sync(fd) && lc_host_sync(state);
  if (close(fd)) okay = false; return okay;
}
static inline bool lc_qualification_make_resource(int state, const lc_host_approval *approval, lc_host_qualification *job) {
  lc_host_scope *scope = job->resource; struct passwd actor, *found = NULL; char account[16384];
  if (getpwuid_r(approval->actor, &actor, account, sizeof(account), &found) || !found) return false;
  memset(scope, 0, sizeof(*scope)); scope->used = true; scope->owner_disconnected = job->original_peer_disconnected; scope->approval = approval; scope->state_directory = state;
  scope->root = scope->fence = scope->namespace = scope->work = scope->journal = scope->stdout_fd = scope->stderr_fd = -1;
  for (size_t i = 0; i < LC_HOST_METADATA_PATHS; i++) scope->metadata_pins.fd[i] = -1;
  scope->record.version = LC_HOST_RESOURCE_RECORD_VERSION; scope->record.purpose = LC_HOST_RESOURCE_SETUP_QUALIFICATION;
  scope->record.phase = LC_HOST_IDLE; scope->record.binding.abi = LC_HOST_ABI; scope->record.binding.actor_uid = approval->actor;
  memcpy(scope->record.setup_manifest_sha256, approval->manifest_sha256, 32); strcpy(scope->record.origin_generation, approval->generation);
  arc4random_buf(scope->record.setup_nonce, 32); arc4random_buf(scope->record.binding.resource_id, 32);
  arc4random_buf(scope->record.binding.broker_resource_generation, 32);
  unsigned char capability[32]; arc4random_buf(capability, 32); lc_host_hex(capability, 32, scope->capability, sizeof(scope->capability));
  CC_SHA256(capability, 32, scope->record.binding.capability_sha256);
  char digest[65]; lc_host_hex(scope->record.binding.capability_sha256, 32, digest, sizeof(digest));
  snprintf(scope->name, sizeof(scope->name), "resource.%s", digest);
  if (!lc_host_boot(scope->record.boot) || !lc_host_unhex(approval->policy, scope->record.binding.policy_sha256, 32) ||
      !lc_host_unhex(approval->policy_generation, scope->record.binding.approved_policy_generation, 32)) return false;
  job->fd[LC_QUAL_PARENT] = lc_host_open_protected(LC_HOST_WORK, true); struct stat parent;
  if (job->fd[LC_QUAL_PARENT] < 0 || fstat(job->fd[LC_QUAL_PARENT], &parent) || !(parent.st_mode & S_IXOTH) || !lc_qualification_no_acl(job->fd[LC_QUAL_PARENT]) ||
      !lc_host_identity(job->fd[LC_QUAL_PARENT], true, &job->parent_identity)) return false;
  snprintf(job->fixture, sizeof(job->fixture), "qualification.%s", job->id);
  if (mkdirat(job->fd[LC_QUAL_PARENT], job->fixture, 0700)) return false;
  scope->root = openat(job->fd[LC_QUAL_PARENT], job->fixture, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (scope->root < 0 || fchown(scope->root, approval->actor, actor.pw_gid) || fchmod(scope->root, 0700) ||
      !lc_host_sync(job->fd[LC_QUAL_PARENT]) || !lc_host_identity(scope->root, true, &scope->record.binding.root) ||
      snprintf(scope->record.root_path, sizeof(scope->record.root_path), "%s/%s", LC_HOST_WORK, job->fixture) >= (int)sizeof(scope->record.root_path)) return false;
  job->fd[LC_QUAL_ROOT_CLEANUP] = fcntl(scope->root, F_DUPFD_CLOEXEC, 20);
  scope->namespace = xpc_fd_dup(xpc_dictionary_get_value(job->original_start, "namespaceFd"));
  struct stat namespace;
  if (scope->namespace < 0 || fstat(scope->namespace, &namespace) || namespace.st_uid != approval->actor ||
      (namespace.st_mode & 0777) != 0700 || !lc_host_identity(scope->namespace, true, &scope->record.binding.namespace) ||
      !lc_host_same(scope->record.binding.namespace, approval->writer_namespace) ||
      fcntl(scope->namespace, F_GETPATH, scope->record.namespace_path) || strcmp(scope->record.namespace_path, approval->writer_namespace_path) ||
      lc_host_beneath(scope->record.root_path, scope->record.namespace_path) || lc_host_beneath(scope->record.namespace_path, scope->record.root_path)) return false;
  snprintf(job->fence_name, sizeof(job->fence_name), "%llx-%llx.lease", (unsigned long long)scope->record.binding.root.device,
    (unsigned long long)scope->record.binding.root.inode);
  scope->fence = openat(scope->namespace, job->fence_name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (scope->fence < 0 || fchown(scope->fence, approval->actor, actor.pw_gid) || fchmod(scope->fence, 0600) ||
      !lc_host_sync(scope->fence) || !lc_host_sync(scope->namespace) || !lc_host_identity(scope->fence, false, &scope->record.binding.fence) ||
      !lc_host_setup_scope_sha256(approval, scope->record.setup_nonce, &scope->record.binding, scope->record.boot, scope->record.binding.scope_sha256) ||
      !lc_host_reserve_principal(state, approval, &scope->record.binding, &scope->record.principal, &scope->record.uid_slot_generation)) return false;
  if (job->fd[LC_QUAL_ROOT_CLEANUP] < 0 || !lc_host_scope_save(state, scope)) return false;
  xpc_release(job->original_start); job->original_start = NULL;
  memset(&job->acquisition, 0, sizeof(job->acquisition)); job->acquisition.version = 1; job->acquisition.binding = scope->record.binding;
  job->acquisition.reservation_fd = openat(state, scope->name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  job->acquisition.reservation_directory_fd = fcntl(state, F_DUPFD_CLOEXEC, 20);
  if (job->acquisition.reservation_fd < 0 || job->acquisition.reservation_directory_fd < 0 ||
      !lc_host_identity(job->acquisition.reservation_fd, false, &job->acquisition.reservation_identity) ||
      !lc_host_identity(job->acquisition.reservation_directory_fd, true, &job->acquisition.reservation_directory_identity)) return false;
  memcpy(job->acquisition.reservation_sha256, scope->record.digest, 32);
  (void)lc_writer_setup_qualification_acquire(scope->fence, scope->root, scope->namespace, approval->actor, &job->acquisition);
  return job->acquisition.phase != LC_WRITER_SETUP_UNKNOWN;
}
static inline bool lc_qualification_fixture(int state, const lc_host_approval *approval, lc_host_qualification *job) {
  lc_host_scope *scope = job->resource; struct passwd actor, *found = NULL; char account[16384], work_name[96];
  if (getpwuid_r(approval->actor, &actor, account, sizeof(account), &found) || !found ||
      !lc_writer_host_resource_prepare(scope->fence, scope->root, scope->namespace, &scope->record.binding) || !lc_host_scope_current(scope)) return false;
  snprintf(work_name, sizeof(work_name), "uid.%u.%llu", scope->record.principal.uid, (unsigned long long)scope->record.uid_slot_generation);
  if (mkdirat(job->fd[LC_QUAL_PARENT], work_name, 0700)) return false;
  scope->work = openat(job->fd[LC_QUAL_PARENT], work_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (scope->work < 0 || fchown(scope->work, scope->record.principal.uid, scope->record.principal.gid) ||
      snprintf(scope->record.work_path, sizeof(scope->record.work_path), "%s/%s", LC_HOST_WORK, work_name) >= (int)sizeof(scope->record.work_path) ||
      !lc_host_sync(job->fd[LC_QUAL_PARENT])) return false;
  job->fd[LC_QUAL_WORK_CLEANUP] = fcntl(scope->work, F_DUPFD_CLOEXEC, 20);
  if (!lc_host_identity(scope->work, true, &job->work_identity)) return false;
  char journal[96]; snprintf(journal, sizeof(journal), "%s.access", scope->name);
  scope->journal = openat(state, journal, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (scope->journal < 0 || job->fd[LC_QUAL_WORK_CLEANUP] < 0) return false;
  scope->access.actor = approval->actor; scope->access.actor_gid = actor.pw_gid;
  scope->access.principal = scope->record.principal; scope->access.journal = scope->journal;
  scope->access.root_path = scope->record.root_path; scope->access.executables = approval->executables;
  scope->access.root_device = scope->record.binding.root.device;
  const char *directories[] = { ".git", ".git/objects", ".git/objects/pack", ".git/objects/info", ".git/refs", ".git/refs/heads", ".git/info" };
  for (size_t i = 0; i < sizeof(directories) / sizeof(directories[0]); i++)
    if (!lc_qualification_directory(scope->root, directories[i], approval->actor, actor.pw_gid)) return false;
  static const char head[] = "ref: refs/heads/qualification\n", config[] = "[core]\nrepositoryformatversion = 0\nbare = false\n";
  if (!lc_qualification_write(scope->root, ".git/HEAD", head, sizeof(head) - 1, approval->actor, actor.pw_gid, 0644) ||
      !lc_qualification_write(scope->root, ".git/config", config, sizeof(config) - 1, approval->actor, actor.pw_gid, 0644) ||
      !lc_qualification_write(scope->root, ".git/qualification-canary", scope->record.setup_nonce, 32, approval->actor, actor.pw_gid, 0666)) return false;
  job->fd[LC_QUAL_METADATA_CANARY] = openat(scope->root, ".git/qualification-canary", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  snprintf(job->outside_name, sizeof(job->outside_name), "qualification-outside.%s", job->id);
  job->fd[LC_QUAL_OUTSIDE] = openat(job->fd[LC_QUAL_PARENT], job->outside_name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (job->fd[LC_QUAL_METADATA_CANARY] < 0 || job->fd[LC_QUAL_OUTSIDE] < 0 ||
      !lc_host_io(job->fd[LC_QUAL_OUTSIDE], scope->record.setup_nonce, 32, true) || fchown(job->fd[LC_QUAL_OUTSIDE], approval->actor, actor.pw_gid) ||
      fchmod(job->fd[LC_QUAL_OUTSIDE], 0666) || !lc_host_sync(job->fd[LC_QUAL_OUTSIDE]) || !lc_host_scope_save(state, scope)) return false;
  job->metadata.version = 1;
  (void)lc_host_setup_metadata_begin(state, approval, scope, &job->acquisition, &job->metadata);
  return job->metadata.phase != LC_SETUP_METADATA_UNKNOWN;
}
static inline bool lc_qualification_socket(int *out) {
  *out = socket(AF_INET, SOCK_STREAM, 0);
  return *out >= 0 && !fcntl(*out, F_SETFL, O_NONBLOCK) && !fcntl(*out, F_SETFD, FD_CLOEXEC);
}
static inline bool lc_qualification_network_begin(lc_host_qualification *job) {
  struct sockaddr_in address; memset(&address, 0, sizeof(address)); address.sin_family = AF_INET;
  address.sin_len = sizeof(address); address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t size = sizeof(address);
  if (!lc_qualification_socket(&job->fd[LC_QUAL_LISTENER]) ||
      bind(job->fd[LC_QUAL_LISTENER], (struct sockaddr *)&address, sizeof(address)) || listen(job->fd[LC_QUAL_LISTENER], 4) ||
      getsockname(job->fd[LC_QUAL_LISTENER], (struct sockaddr *)&address, &size) || size != sizeof(address) || !address.sin_port ||
      !lc_qualification_socket(&job->fd[LC_QUAL_POSITIVE])) return false;
  job->port = ntohs(address.sin_port);
  return !connect(job->fd[LC_QUAL_POSITIVE], (struct sockaddr *)&address, sizeof(address)) || errno == EINPROGRESS;
}
static inline bool lc_qualification_network_poll(lc_host_qualification *job) {
  if (job->socket_positive) return true;
  int error = 0; socklen_t size = sizeof(error);
  if (getsockopt(job->fd[LC_QUAL_POSITIVE], SOL_SOCKET, SO_ERROR, &error, &size) || size != sizeof(error) || error) return false;
  if (job->positive_sent < 32) {
    ssize_t count = send(job->fd[LC_QUAL_POSITIVE], job->resource->record.setup_nonce + job->positive_sent, 32 - job->positive_sent, 0);
    if (count > 0) job->positive_sent += (size_t)count;
    else if (count == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR && errno != ENOTCONN)) return false;
  }
  if (job->fd[LC_QUAL_ACCEPTED] < 0) {
    job->fd[LC_QUAL_ACCEPTED] = accept(job->fd[LC_QUAL_LISTENER], NULL, NULL);
    if (job->fd[LC_QUAL_ACCEPTED] < 0) return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
    if (fcntl(job->fd[LC_QUAL_ACCEPTED], F_SETFL, O_NONBLOCK) || fcntl(job->fd[LC_QUAL_ACCEPTED], F_SETFD, FD_CLOEXEC)) return false;
  }
  if (job->positive_received < 32) {
    ssize_t count = recv(job->fd[LC_QUAL_ACCEPTED], job->positive_bytes + job->positive_received, 32 - job->positive_received, 0);
    if (count > 0) job->positive_received += (size_t)count;
    else if (count == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) return false;
  }
  if (job->positive_sent == 32 && job->positive_received == 32) {
    if (memcmp(job->positive_bytes, job->resource->record.setup_nonce, 32) || !lc_qualification_close(job, LC_QUAL_POSITIVE) ||
        !lc_qualification_close(job, LC_QUAL_ACCEPTED)) return false;
    job->socket_positive = true;
  }
  return true;
}
static inline bool lc_qualification_package_files(const lc_host_approval *approval, lc_host_qualification *job) {
  lc_host_scope *scope = job->resource; struct passwd actor, *found = NULL; char account[16384];
  if (getpwuid_r(approval->actor, &actor, account, sizeof(account), &found) || !found || !lc_host_scope_current(scope)) return false;
  char node[PATH_MAX * 2], captured_path[8192], path_json[16386];
  static const char package[] = "{\"name\":\"native-qualification\",\"version\":\"1.0.0\",\"private\":true,\"scripts\":{\"test\":\"node .qualifier-test.cjs\",\"build\":\"node .qualifier-build.cjs\"}}\n";
  if (!lc_qualification_json(job->tools.node, node, sizeof(node)) || !lc_host_command_path(approval, captured_path, sizeof(captured_path)) ||
      !lc_qualification_json(captured_path, path_json, sizeof(path_json)) ||
      !lc_qualification_directory(scope->root, "node_modules", approval->actor, actor.pw_gid) ||
      !lc_qualification_directory(scope->root, "node_modules/.bin", approval->actor, actor.pw_gid)) return false;
  char outside[PATH_MAX], outside_json[PATH_MAX * 2], nonce[65];
  if (snprintf(outside, sizeof(outside), "%s/%s", LC_HOST_WORK, job->outside_name) >= (int)sizeof(outside) ||
      !lc_qualification_json(outside, outside_json, sizeof(outside_json))) return false;
  lc_host_hex(scope->record.setup_nonce, 32, nonce, sizeof(nonce));
  char *configuration = calloc(1, 131072); if (!configuration) return false;
  int count = snprintf(configuration, 131072, "{\"node\":%s,\"path\":%s,\"nonce\":\"%s\",\"port\":%u,\"outside\":%s,\"protected\":[", node, path_json, nonce, job->port, outside_json);
  bool okay = count > 0 && count < 131072; size_t at = okay ? (size_t)count : 0;
  for (CFIndex i = -2; okay && i < CFArrayGetCount(approval->protected_roots); i++) {
    char path[PATH_MAX], encoded[PATH_MAX * 2];
    if (i == -2) strcpy(path, approval->bundle); else if (i == -1) strcpy(path, LC_HOST_STATE);
    else if (!lc_host_text(CFArrayGetValueAtIndex(approval->protected_roots, i), path, sizeof(path))) { okay = false; break; }
    if (!lc_qualification_json(path, encoded, sizeof(encoded))) { okay = false; break; }
    count = snprintf(configuration + at, 131072 - at, "%s%s", i == -2 ? "" : ",", encoded);
    if (count < 0 || (size_t)count >= 131072 - at) { okay = false; break; } at += (size_t)count;
  }
  if (okay) { count = snprintf(configuration + at, 131072 - at, "]}\n"); okay = count > 0 && (size_t)count < 131072 - at; if (okay) at += (size_t)count; }
  okay = okay && lc_qualification_write(scope->root, ".qualifier-config.json", configuration, at, approval->actor, actor.pw_gid, 0644) &&
    lc_qualification_write(scope->root, "package.json", package, strlen(package), approval->actor, actor.pw_gid, 0644) &&
    lc_qualification_write(scope->root, ".qualifier-test.cjs", lc_qualification_test_script, sizeof(lc_qualification_test_script) - 1, approval->actor, actor.pw_gid, 0644) &&
    lc_qualification_write(scope->root, ".qualifier-build.cjs", lc_qualification_build_script, sizeof(lc_qualification_build_script) - 1, approval->actor, actor.pw_gid, 0644) &&
    lc_qualification_write(scope->root, ".qualifier-flood.cjs", lc_qualification_flood_script, sizeof(lc_qualification_flood_script) - 1, approval->actor, actor.pw_gid, 0644) &&
    lc_qualification_write(scope->root, "node_modules/.bin/native-qualification-bin", lc_qualification_package_bin_script, sizeof(lc_qualification_package_bin_script) - 1, approval->actor, actor.pw_gid, 0755) &&
    lc_qualification_write(scope->root, ".qualifier-core-script", lc_qualification_core_shell_script, sizeof(lc_qualification_core_shell_script) - 1, approval->actor, actor.pw_gid, 0755) && lc_host_sync(scope->root);
  free(configuration); return okay;
}
static inline bool lc_qualification_command(int state, const lc_host_approval *approval, lc_host_qualification *job, const char *recipe) {
  char command[501];
  if (!lc_host_qualification_toolchain_current(approval, &job->tools)) return false;
  int count;
  if (!strcmp(recipe, "flood")) count = snprintf(command, sizeof(command), "node .qualifier-flood.cjs");
  else if (!strcmp(recipe, "test") || !strcmp(recipe, "build"))
    count = snprintf(command, sizeof(command), "npm run %s", recipe);
  else return false;
  if (count < 0 || count >= (int)sizeof(command)) return false;
  xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0); if (!request) return false;
  lc_host_put(request, "version", "1"); lc_host_put(request, "operation", "prepareCommand"); lc_host_put(request, "generation", approval->generation);
  lc_host_put(request, "capability", job->resource->capability); lc_host_put(request, "commandId", recipe); lc_host_put(request, "command", command); lc_host_put(request, "cwd", ".");
  const char *keys[] = { LC_HOST_METADATA_FIELDS };
  for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++)
    lc_host_put(request, keys[i], i == 0 ? job->resource->record.metadata.identity : i == 1 ? job->resource->record.metadata.storage_identity : job->resource->record.metadata.paths[i - 2]);
  bool okay = lc_host_prepare_command_internal(state, approval, job->resource, request, LC_HOST_RESOURCE_SETUP_QUALIFICATION) &&
    lc_host_release_command_internal(state, approval, job->resource, LC_HOST_RESOURCE_SETUP_QUALIFICATION);
  xpc_release(request); return okay;
}
static inline bool lc_qualification_read(int root, const char *name, void *bytes, size_t size, uid_t actor, uint64_t device) {
  int fd = openat(root, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); struct stat held, named;
  if (fd < 0) return false;
  bool okay = !fstat(fd, &held) && !fstatat(root, name, &named, AT_SYMLINK_NOFOLLOW) && S_ISREG(held.st_mode) &&
    held.st_nlink == 1 && held.st_size == (off_t)size && held.st_uid == actor && (uint64_t)held.st_dev == device &&
    held.st_dev == named.st_dev && held.st_ino == named.st_ino && lc_host_io(fd, bytes, size, false);
  if (close(fd)) okay = false; return okay;
}
static inline bool lc_qualification_canary(int fd, int parent, const char *name, const unsigned char nonce[32]) {
  struct stat held, named; unsigned char bytes[32]; ssize_t count;
  if (fd < 0 || fstat(fd, &held) || fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) || !S_ISREG(held.st_mode) ||
      held.st_nlink != 1 || held.st_size != 32 || (held.st_mode & 0777) != 0666 || !lc_qualification_no_acl(fd) ||
      held.st_dev != named.st_dev || held.st_ino != named.st_ino) return false;
  do { count = pread(fd, bytes, sizeof(bytes), 0); } while (count < 0 && errno == EINTR);
  return count == 32 && !memcmp(bytes, nonce, 32);
}
static inline bool lc_qualification_observe_detached(const lc_host_approval *approval, lc_host_qualification *job) {
  if (job->detached_observed) return true;
  lc_host_scope *scope = job->resource; struct stat st;
  if (fstatat(scope->root, ".qualifier-descendant", &st, AT_SYMLINK_NOFOLLOW)) return errno == ENOENT;
  unsigned char marker[40];
  if (!lc_qualification_read(scope->root, ".qualifier-descendant", marker, sizeof(marker), scope->record.principal.uid, scope->record.binding.root.device) ||
      memcmp(marker, "LCQD", 4) || memcmp(marker + 4, scope->record.setup_nonce, 32)) return false;
  uint32_t pid = lc_host_read32(marker + 36); struct proc_bsdinfo observed;
  if (pid <= 1 || pid > INT_MAX || pid == (uint32_t)scope->child ||
      proc_pidinfo((pid_t)pid, PROC_PIDTBSDINFO, 0, &observed, sizeof(observed)) != sizeof(observed) ||
      observed.pbi_pid != pid || observed.pbi_pgid != pid || observed.pbi_uid != scope->record.principal.uid ||
      observed.pbi_ruid != scope->record.principal.uid || observed.pbi_svuid != scope->record.principal.uid ||
      observed.pbi_gid != scope->record.principal.gid || observed.pbi_rgid != scope->record.principal.gid ||
      observed.pbi_svgid != scope->record.principal.gid || !observed.pbi_start_tvsec || lc_host_uid_zero(scope->record.principal.uid)) return false;
  job->detached_pid = (pid_t)pid; job->detached_start_seconds = observed.pbi_start_tvsec;
  job->detached_start_microseconds = observed.pbi_start_tvusec;
  struct passwd actor, *found = NULL; char account[16384];
  if (getpwuid_r(approval->actor, &actor, account, sizeof(account), &found) || !found ||
      !lc_qualification_write(scope->root, ".qualifier-detached-ack.next", scope->record.setup_nonce, 32, approval->actor, actor.pw_gid, 0644) ||
      renameat(scope->root, ".qualifier-detached-ack.next", scope->root, ".qualifier-detached-ack") || !lc_host_sync(scope->root)) return false;
  job->detached_observed = true; return true;
}
static inline bool lc_qualification_detached_closed(lc_host_qualification *job) {
  if (!job->detached_observed) return false;
  errno = 0;
  if (kill(job->detached_pid, 0)) return errno == ESRCH;
  struct proc_bsdinfo current;
  if (proc_pidinfo(job->detached_pid, PROC_PIDTBSDINFO, 0, &current, sizeof(current)) != sizeof(current)) return false;
  /* A different kernel birth identity proves the ORIGINAL is gone, without
   * signalling or making any assertion about that later PID occupant. */
  return current.pbi_start_tvsec != job->detached_start_seconds || current.pbi_start_tvusec != job->detached_start_microseconds;
}
static inline bool lc_qualification_evidence(const lc_host_approval *approval, lc_host_qualification *job, bool build) {
  lc_host_scope *scope = job->resource;
  if (scope->record.phase != LC_HOST_IDLE || !scope->reaped || !WIFEXITED(scope->wait_status) || WEXITSTATUS(scope->wait_status) ||
      scope->timed_out || !scope->stdout_closed || !scope->stderr_closed || scope->access.count || scope->access.unknown ||
      !lc_host_uid_zero(scope->record.principal.uid) || !lc_host_scope_current(scope) ||
      !lc_host_qualification_toolchain_current(approval, &job->tools) ||
      !lc_qualification_canary(job->fd[LC_QUAL_OUTSIDE], job->fd[LC_QUAL_PARENT], job->outside_name, scope->record.setup_nonce) ||
      !lc_qualification_canary(job->fd[LC_QUAL_METADATA_CANARY], job->fd[LC_QUAL_ROOT_CLEANUP], ".git/qualification-canary", scope->record.setup_nonce)) return false;
  /* The host listener remains live. A successful command-side connection is
   * independently visible here and can never count as network denial. */
  int connection = accept(job->fd[LC_QUAL_LISTENER], NULL, NULL);
  if (connection >= 0) { job->fd[LC_QUAL_ACCEPTED] = connection; job->fd_closed[LC_QUAL_ACCEPTED] = false; return false; }
  if (errno != EAGAIN && errno != EWOULDBLOCK) return false;
  unsigned char result[40], descendant[40];
  if (!lc_qualification_read(scope->root, ".qualifier-result", result, sizeof(result), approval->actor, scope->record.binding.root.device) ||
      memcmp(result, "LCQ1", 4) || memcmp(result + 4, scope->record.setup_nonce, 32) || lc_host_read32(result + 36) != 511 ||
      !lc_qualification_read(scope->root, ".qualifier-descendant", descendant, sizeof(descendant), approval->actor, scope->record.binding.root.device) ||
      memcmp(descendant, "LCQD", 4) || memcmp(descendant + 4, scope->record.setup_nonce, 32) ||
      lc_host_read32(descendant + 36) != (uint32_t)job->detached_pid || !job->detached_observed || !job->detached_closed) return false;
  unsigned char package_bin[32];
  if (!lc_qualification_read(scope->root, ".qualifier-package-bin", package_bin, sizeof(package_bin), approval->actor, scope->record.binding.root.device) ||
      memcmp(package_bin, scope->record.setup_nonce, 32)) return false;
  unsigned char core_utils[32];
  if (!lc_qualification_read(scope->root, ".qualifier-core-utils", core_utils, sizeof(core_utils), approval->actor, scope->record.binding.root.device) ||
      memcmp(core_utils, scope->record.setup_nonce, 32)) return false;
  CC_SHA256(core_utils, sizeof(core_utils), job->core_utils_sha256);
  CC_SHA256(package_bin, sizeof(package_bin), job->package_bin_sha256);
  CC_SHA256(result, sizeof(result), job->result_sha256);
  if (build) {
    unsigned char bytes[32];
    if (!lc_qualification_read(scope->root, ".qualifier-build", bytes, sizeof(bytes), approval->actor, scope->record.binding.root.device) ||
        memcmp(bytes, job->result_sha256, 32)) return false;
    CC_SHA256(bytes, sizeof(bytes), job->build_sha256);
  }
  return true;
}
typedef struct {
  uint32_t version, bytes, recipe, purpose, actor, scenario_bits, original_closure_bits, reserved;
  char boot[40], kernel[256], generation[65], permit[65], qualification_id[65];
  char bundle_cdhash[129], bridge_cdhash[129], helper_cdhash[129], node_cdhash[129], env_cdhash[129];
  unsigned char manifest_sha256[32], broker_sha256[32], node_sha256[32], npm_sha256[32], bash_sha256[32], npm_launcher_sha256[32], env_sha256[32];
  unsigned char core_sha256[LC_HOST_CORE_EXECUTABLE_COUNT][32];
  char core_cdhash[LC_HOST_CORE_EXECUTABLE_COUNT][129];
  lc_host_writer_binding binding;
  uint64_t slot_generation, stop_stdout_bytes, detached_start_seconds, detached_start_microseconds;
  uint32_t detached_pid, detached_closed;
  unsigned char cleanup_receipt[32], retirement_receipt[32], metadata_sha256[32], g_sha256[32];
  unsigned char snapshot_sha256[32], result_sha256[32], build_sha256[32], package_bin_sha256[32], core_utils_sha256[32], start_bridge_nonce[32];
  lc_host_file_identity snapshot_identity, tool_identity[LC_HOST_TOOLCHAIN_ROLES];
  _Alignas(8) unsigned char digest[32];
} lc_host_qualification_receipt;
_Static_assert(offsetof(lc_host_qualification_receipt, digest) + 32 == sizeof(lc_host_qualification_receipt), "Qualification digest covers complete receipt");
static inline bool lc_qualification_receipt_validate(int state, const lc_host_approval *approval, const char *id,
    const unsigned char expected[32]) {
  char path[PATH_MAX], boot[40], kernel[256]; size_t size = sizeof(kernel); struct stat st, held, named;
  if (snprintf(path, sizeof(path), "%s/qualification.%s", LC_HOST_STATE, id) >= (int)sizeof(path)) return false;
  int fd = lc_host_open_protected(path, false); if (fd < 0) return false;
  lc_host_qualification_receipt record; memset(&record, 0, sizeof(record));
  bool okay = !fstat(fd, &st) && st.st_size == sizeof(record) && st.st_nlink == 1 && (st.st_mode & 0777) == 0600 && lc_host_io(fd, &record, sizeof(record), false);
  if (close(fd)) okay = false;
  unsigned char digest[32], policy[32], generation[32]; CC_SHA256(&record, (CC_LONG)offsetof(lc_host_qualification_receipt, digest), digest);
  return okay && record.version == 2 && record.bytes == sizeof(record) && record.recipe == LC_HOST_TOOLCHAIN_RECIPE && !record.reserved &&
    record.purpose == LC_HOST_RESOURCE_SETUP_QUALIFICATION && record.actor == approval->actor && record.scenario_bits == 511 &&
    record.original_closure_bits == 0xfff && record.slot_generation && record.stop_stdout_bytes >= 32768 &&
    record.detached_pid > 1 && record.detached_closed == 1 && record.detached_start_seconds &&
    !memcmp(record.digest, digest, 32) && !memcmp(record.digest, expected, 32) &&
    !memcmp(record.manifest_sha256, approval->manifest_sha256, 32) &&
    memchr(record.qualification_id, 0, sizeof(record.qualification_id)) && memchr(record.generation, 0, sizeof(record.generation)) &&
    memchr(record.permit, 0, sizeof(record.permit)) && memchr(record.kernel, 0, sizeof(record.kernel)) &&
    !strcmp(record.qualification_id, id) && !strcmp(record.generation, approval->generation) && !strcmp(record.permit, approval->setup_permit_id) &&
    lc_host_boot(boot) && !memcmp(record.boot, boot, 40) && !sysctlbyname("kern.osrelease", kernel, &size, NULL, 0) &&
    memchr(kernel, 0, sizeof(kernel)) && !strcmp(kernel, record.kernel) && !strcmp(kernel, approval->kernel_release) &&
    lc_host_unhex(approval->policy, policy, 32) && lc_host_unhex(approval->policy_generation, generation, 32) &&
    !memcmp(record.binding.policy_sha256, policy, 32) && !memcmp(record.binding.approved_policy_generation, generation, 32) &&
    lc_host_same(record.binding.namespace, approval->writer_namespace) && record.binding.actor_uid == approval->actor &&
    !fstat(state, &held) && !lstat(LC_HOST_STATE, &named) && held.st_dev == named.st_dev && held.st_ino == named.st_ino &&
    lc_host_installed_broker_valid(approval) && lc_host_bundle_valid((lc_host_approval *)approval);
}
static inline bool lc_qualification_publish(int state, lc_host_approval *approval, lc_host_qualification *job) {
  lc_host_scope *scope = job->resource;
  if (!job->bridge_confirmed || !scope || !scope->owner_disconnected || !job->socket_positive || !job->package_test || !job->package_build ||
      !job->stop_observed || !job->detached_observed || !job->detached_closed || job->cancel_requested || job->failed || !scope->released || !scope->sealed ||
      !scope->record.cleanup_closed || scope->record.phase != LC_HOST_CLOSED || !scope->record.retirement_confirmed ||
      scope->access.count || scope->access.unknown || !scope->launch_closed || !scope->reaped || !scope->stdout_closed || !scope->stderr_closed ||
      scope->signaler || !job->metadata.image.closed || job->metadata.phase != LC_SETUP_METADATA_READY ||
      job->acquisition.phase != LC_WRITER_SETUP_ACQUIRED || !job->acquisition.child_reaped || !job->acquisition.control_closed ||
      !job->acquisition.control_write_closed || !job->acquisition.control_eof || !job->acquisition.report_valid ||
      job->acquisition.reservation_fd != -1 || job->acquisition.reservation_directory_fd != -1) return false;
  for (size_t i = 0; i < LC_QUAL_FDS; i++) if (!job->fd_closed[i]) return false;
  for (size_t i = 0; i < LC_HOST_TOOLCHAIN_ROLES; i++) if (!job->tools.closed[i]) return false;
  for (size_t i = 0; i < 7; i++) if (job->metadata.descriptor_close[i] != 1) return false;
  lc_host_reservation slot;
  if (!lc_host_reservation_read(state, approval, scope->record.principal.uid, &slot) || slot.state != LC_HOST_SLOT_AVAILABLE ||
      slot.slot_generation != scope->record.uid_slot_generation || memcmp(&slot.binding, &scope->record.binding, sizeof(slot.binding)) ||
      memcmp(slot.cleanup_receipt, scope->record.cleanup_receipt, 32) || memcmp(slot.retirement_receipt, scope->record.retirement_receipt, 32)) return false;
  lc_host_qualification_receipt record; memset(&record, 0, sizeof(record));
  record.version = 2; record.bytes = sizeof(record); record.recipe = LC_HOST_TOOLCHAIN_RECIPE; record.purpose = LC_HOST_RESOURCE_SETUP_QUALIFICATION;
  record.actor = approval->actor; record.scenario_bits = 511; record.original_closure_bits = 0xfff;
  memcpy(record.boot, scope->record.boot, 40); strcpy(record.kernel, approval->kernel_release); strcpy(record.generation, approval->generation);
  strcpy(record.permit, approval->setup_permit_id); strcpy(record.qualification_id, job->id); strcpy(record.node_cdhash, job->tools.node_cdhash); strcpy(record.env_cdhash, job->tools.env_cdhash);
  if (!lc_host_text(CFDictionaryGetValue(approval->manifest, CFSTR("BundleCDHash")), record.bundle_cdhash, sizeof(record.bundle_cdhash)) ||
      !lc_host_text(CFDictionaryGetValue(approval->manifest, CFSTR("BridgeCDHash")), record.bridge_cdhash, sizeof(record.bridge_cdhash)) ||
      !lc_host_text(CFDictionaryGetValue(approval->manifest, CFSTR("FilesystemHelperCDHash")), record.helper_cdhash, sizeof(record.helper_cdhash))) return false;
  char broker[65];
  if (!lc_host_text(CFDictionaryGetValue(approval->manifest, CFSTR("BrokerSHA256")), broker, sizeof(broker)) || !lc_host_unhex(broker, record.broker_sha256, 32) ||
      !lc_host_unhex(job->tools.node_sha, record.node_sha256, 32) || !lc_host_unhex(job->tools.npm_sha, record.npm_sha256, 32) ||
      !lc_host_unhex(job->tools.bash_sha, record.bash_sha256, 32) || !lc_host_unhex(job->tools.launcher_sha, record.npm_launcher_sha256, 32) ||
      !lc_host_unhex(job->tools.env_sha, record.env_sha256, 32) || !lc_host_unhex(job->bridge_nonce, record.start_bridge_nonce, 32)) return false;
  for (size_t i = 0; i < LC_HOST_CORE_EXECUTABLE_COUNT; i++) {
    if (!lc_host_unhex(job->tools.core_sha[i], record.core_sha256[i], 32)) return false;
    strcpy(record.core_cdhash[i], job->tools.core_cdhash[i]);
  }
  memcpy(record.manifest_sha256, approval->manifest_sha256, 32); record.binding = scope->record.binding;
  record.slot_generation = scope->record.uid_slot_generation; record.stop_stdout_bytes = scope->stdout_size;
  record.detached_pid = (uint32_t)job->detached_pid; record.detached_closed = 1;
  record.detached_start_seconds = job->detached_start_seconds; record.detached_start_microseconds = job->detached_start_microseconds;
  memcpy(record.cleanup_receipt, scope->record.cleanup_receipt, 32); memcpy(record.retirement_receipt, scope->record.retirement_receipt, 32);
  memcpy(record.metadata_sha256, scope->record.metadata.digest, 32); memcpy(record.g_sha256, job->g_sha256, 32);
  memcpy(record.snapshot_sha256, job->metadata.image.sha256, 32); record.snapshot_identity = job->metadata.image.file_identity;
  memcpy(record.tool_identity, job->tools.identity, sizeof(record.tool_identity)); memcpy(record.result_sha256, job->result_sha256, 32); memcpy(record.build_sha256, job->build_sha256, 32); memcpy(record.package_bin_sha256, job->package_bin_sha256, 32); memcpy(record.core_utils_sha256, job->core_utils_sha256, 32);
  CC_SHA256(&record, (CC_LONG)offsetof(lc_host_qualification_receipt, digest), record.digest);
  char name[96]; snprintf(name, sizeof(name), "qualification.%s", job->id);
  int fd = openat(state, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  bool okay = lc_host_io(fd, &record, sizeof(record), true) && lc_host_sync(fd) && lc_host_sync(state);
  if (close(fd)) okay = false;
  if (!okay || !lc_qualification_receipt_validate(state, approval, job->id, record.digest)) return false;
  memcpy(job->pass_receipt, record.digest, 32);
  /* A live projection of this actual protected receipt, never manifest bool,
   * build/status self-attestation, or an old-boot/restarted-daemon fallback. */
  approval->qualified = true; return true;
}
/* Cancellation before G has no U/access/private-UID command obligation. Settle
 * only the ORIGINAL service-created H loan after its actual actor control/reap;
 * do not start a helper or manufacture a G/U/V merely to make cleanup fit. */
static inline bool lc_qualification_cancel_unexposed(int state, const lc_host_approval *approval, lc_host_qualification *job) {
  lc_host_scope *scope = job->resource; lc_writer_setup_acquisition *acquisition = &job->acquisition;
  lc_host_file_identity root, namespace, fence;
  if (!job->cancel_requested || !scope || scope->record.purpose != LC_HOST_RESOURCE_SETUP_QUALIFICATION ||
      scope->record.setup_metadata_started || scope->record.setup_metadata_inspected || scope->record.command_count ||
      scope->child || scope->signaler || scope->access.count || scope->access_ready || scope->work != -1 || scope->journal != -1 ||
      acquisition->phase != LC_WRITER_SETUP_ACQUIRED || !acquisition->report_valid || !acquisition->child_reaped ||
      !acquisition->control_eof || !acquisition->control_closed || !acquisition->control_write_closed ||
      !lc_host_reservation_current(state, approval, &scope->record.binding, scope->record.uid_slot_generation) ||
      !lc_host_uid_zero(scope->record.principal.uid) || !lc_host_identity(scope->root, true, &root) ||
      !lc_host_identity(scope->namespace, true, &namespace) || !lc_host_identity(scope->fence, false, &fence) ||
      !lc_host_same(root, scope->record.binding.root) || !lc_host_same(namespace, scope->record.binding.namespace) || !lc_host_same(fence, scope->record.binding.fence)) return false;
  scope->sealed = true; scope->record.phase = LC_HOST_CLOSING;
  if (!lc_host_scope_save(state, scope)) return false;
  int *originals[] = { &scope->root, &scope->namespace, &scope->fence };
  for (size_t i = 0; i < 3; i++) if (!lc_host_launch_close(originals[i])) return false;
  scope->record.phase = LC_HOST_CLOSED; scope->record.cleanup_closed = 1;
  arc4random_buf(scope->record.cleanup_receipt, 32);
  if (!lc_host_scope_save(state, scope)) return false;
  scope->released = true; job->unexposed = true; job->phase = LC_QUAL_CLOSING; return true;
}
static inline bool lc_qualification_dispose_root(lc_host_qualification *job, size_t index, const char *name, lc_host_file_identity expected) {
  struct stat named, held, parent;
  if (fstat(job->fd[LC_QUAL_PARENT], &parent) || (uint64_t)parent.st_dev != job->parent_identity.device ||
      (uint64_t)parent.st_ino != job->parent_identity.inode || !lc_host_protected_fd(job->fd[LC_QUAL_PARENT], true) ||
      fstat(job->fd[index], &held) || !S_ISDIR(held.st_mode) || (uint64_t)held.st_dev != expected.device ||
      (uint64_t)held.st_ino != expected.inode || fstatat(job->fd[LC_QUAL_PARENT], name, &named, AT_SYMLINK_NOFOLLOW) ||
      named.st_dev != held.st_dev || named.st_ino != held.st_ino || unlinkat(job->fd[LC_QUAL_PARENT], name, AT_REMOVEDIR) ||
      !lc_host_sync(job->fd[LC_QUAL_PARENT]) || !lc_qualification_close(job, index)) return false;
  return true;
}
static inline bool lc_qualification_cleanup_tick(int state, lc_host_approval *approval, lc_host_qualification *job) {
  lc_host_scope *scope = job->resource;
  if (!scope || !scope->released || !scope->record.cleanup_closed || scope->record.phase != LC_HOST_CLOSED || scope->access.count || scope->access.unknown) return false;
  if (!job->cleanup_target) {
    if (!lc_host_qualification_toolchain_current(approval, &job->tools) ||
        !lc_qualification_close(job, LC_QUAL_LISTENER) || !lc_qualification_close(job, LC_QUAL_POSITIVE) ||
        !lc_qualification_close(job, LC_QUAL_ACCEPTED) || !lc_qualification_close(job, LC_QUAL_METADATA_CANARY) ||
        !lc_qualification_cleanup_begin(job->fd[LC_QUAL_ROOT_CLEANUP], approval->actor, &job->cleanup)) return false;
    job->cleanup_target = 1;
  }
  if (job->cleanup_target <= 2) {
    uint64_t start, now; if (!lc_host_monotonic(&start)) return false;
    for (size_t i = 0; i < 8 && !job->cleanup.complete; i++) {
      if (!lc_host_monotonic(&now)) return false;
      if (now - start >= 2) return true;
      if (!lc_qualification_cleanup_step(&job->cleanup)) return false;
    }
    if (!job->cleanup.complete) return true;
    if (job->cleanup_target == 1) {
      if (!lc_qualification_dispose_root(job, LC_QUAL_ROOT_CLEANUP, job->fixture, scope->record.binding.root)) return false;
      memset(&job->cleanup, 0, sizeof(job->cleanup));
      if (job->unexposed) { job->cleanup_target = 3; }
      else {
        if (!lc_qualification_cleanup_begin(job->fd[LC_QUAL_WORK_CLEANUP], approval->actor, &job->cleanup)) return false;
        job->cleanup_target = 2; return true;
      }
    }
    if (!job->unexposed) {
      const char *name = strrchr(scope->record.work_path, '/');
      if (!name || !lc_qualification_dispose_root(job, LC_QUAL_WORK_CLEANUP, name + 1, job->work_identity)) return false;
      if (!lc_qualification_canary(job->fd[LC_QUAL_OUTSIDE], job->fd[LC_QUAL_PARENT], job->outside_name, scope->record.setup_nonce) ||
          unlinkat(job->fd[LC_QUAL_PARENT], job->outside_name, 0) || !lc_host_sync(job->fd[LC_QUAL_PARENT]) ||
          !lc_qualification_close(job, LC_QUAL_OUTSIDE)) return false;
    }
    job->cleanup_target = 3;
  }
  if (job->cleanup_target == 3) {
    if (!lc_qualification_close(job, LC_QUAL_WORK_CLEANUP) || !lc_qualification_close(job, LC_QUAL_OUTSIDE) ||
        !lc_qualification_close(job, LC_QUAL_PARENT)) return false;
    if (!lc_host_qualification_toolchain_current(approval, &job->tools) || !lc_host_qualification_toolchain_close(&job->tools)) return false;
    int original = job->acquisition.reservation_fd; job->acquisition.reservation_fd = -1;
    if (original < 0 || close(original)) return false;
    original = job->acquisition.reservation_directory_fd; job->acquisition.reservation_directory_fd = -1;
    if (original < 0 || close(original)) return false;
    job->cleanup_target = 4;
  }
  if (!job->bridge_confirmed || !job->original_peer_disconnected || !scope->owner_disconnected) { job->phase = LC_QUAL_BRIDGE; return true; }
  /* Setup's original non-Turn fence is service-owned and is now actually
   * closed, along with its H/acquisition/G/command/cleanup loans. It does not
   * impersonate Main's releaseAttempt callback or settle a Native attempt. */
  if (!lc_host_retirement_begin(state, scope)) return false;
  unsigned char digest[32]; char text[65]; lc_host_retirement_digest(&scope->record, digest);
  xpc_object_t confirmation = xpc_dictionary_create(NULL, NULL, 0); if (!confirmation) return false;
  lc_host_put(confirmation, "version", "1"); lc_host_put(confirmation, "operation", "confirmResourceRetirement");
  lc_host_put(confirmation, "generation", approval->generation); lc_host_put(confirmation, "capability", scope->capability);
  lc_host_hex(scope->record.binding.resource_id, 32, text, sizeof(text)); lc_host_put(confirmation, "resourceId", text);
  lc_host_hex(scope->record.binding.broker_resource_generation, 32, text, sizeof(text)); lc_host_put(confirmation, "resourceGeneration", text);
  lc_host_put_number(confirmation, "slotGeneration", scope->record.uid_slot_generation);
  lc_host_hex(scope->record.cleanup_receipt, 32, text, sizeof(text)); lc_host_put(confirmation, "cleanupReceipt", text);
  lc_host_hex(scope->record.retirement_nonce, 32, text, sizeof(text)); lc_host_put(confirmation, "retirementNonce", text);
  lc_host_hex(digest, 32, text, sizeof(text)); lc_host_put(confirmation, "hostReleaseSHA256", text);
  bool retired = lc_host_retirement_finish(state, approval, scope, confirmation); xpc_release(confirmation);
  if (!retired) return false;
  if (job->cancel_requested) job->phase = LC_QUAL_CANCELLED;
  else if (lc_qualification_publish(state, approval, job)) job->phase = LC_QUAL_PASSED;
  else return false;
  scope->used = false; job->metadata.resource = NULL; job->resource = NULL; job->owner_releasable = true;
  return true;
}
static inline void lc_host_qualification_tick(int state, lc_host_approval *approval, lc_host_qualification *job) {
  if (!job->used || job->phase == LC_QUAL_PASSED || job->phase == LC_QUAL_CANCELLED) return;
  if (job->phase == LC_QUAL_UNKNOWN) {
    if (job->acquisition.version) (void)lc_writer_setup_qualification_poll(&job->acquisition);
    if (job->metadata.version) (void)lc_host_setup_metadata_poll(state, approval, &job->metadata);
    return;
  }
  if (job->phase == LC_QUAL_HISTORY) {
    if (job->cancel_requested) {
      if (!lc_host_scan_close(&job->history) || !lc_host_qualification_toolchain_close(&job->tools)) { lc_qualification_unknown(state, job); return; }
      if (job->original_start) { xpc_release(job->original_start); job->original_start = NULL; }
      job->phase = LC_QUAL_CANCELLED; job->resource = NULL; job->owner_releasable = true; return;
    }
    uint64_t start, now; if (!lc_host_monotonic(&start)) { lc_qualification_unknown(state, job); return; }
    for (size_t i = 0; i < 8 && job->history.phase == LC_HOST_SCAN_PENDING; i++) {
      if (!lc_host_monotonic(&now) || now - start >= 2) return;
      lc_host_scan_step(state, &job->history);
    }
    if (job->history.phase == LC_HOST_SCAN_PENDING) return;
    if (job->history.phase != LC_HOST_SCAN_COMPLETE || job->history.unsettled ||
        !lc_host_qualification_toolchain_current(approval, &job->tools) || !lc_host_monotonic(&job->deadline) ||
        !lc_qualification_consume(state, approval, job) || !lc_qualification_make_resource(state, approval, job)) {
      lc_qualification_unknown(state, job); return;
    }
    job->deadline += 120000; job->phase = LC_QUAL_ACQUIRE; return;
  }
  uint64_t now;
  if (!lc_host_monotonic(&now)) { lc_qualification_unknown(state, job); return; }
  if (now >= job->deadline) {
    if (job->phase == LC_QUAL_BRIDGE) { lc_qualification_unknown(state, job); return; }
    job->cancel_requested = true; job->failed = true;
  }
  lc_host_scope *scope = job->resource;
  if (!scope || scope->record.phase == LC_HOST_UNKNOWN) { lc_qualification_unknown(state, job); return; }
  if (job->phase == LC_QUAL_ACQUIRE) {
    (void)lc_writer_setup_qualification_poll(&job->acquisition);
    if (job->acquisition.phase == LC_WRITER_SETUP_PENDING) return;
    if (job->acquisition.phase != LC_WRITER_SETUP_ACQUIRED) { lc_qualification_unknown(state, job); return; }
    if (job->cancel_requested) {
      if (!lc_qualification_cancel_unexposed(state, approval, job)) lc_qualification_unknown(state, job);
      return;
    }
    if (!lc_qualification_fixture(state, approval, job)) { lc_qualification_unknown(state, job); return; }
    job->phase = LC_QUAL_METADATA; return;
  }
  if (job->phase == LC_QUAL_METADATA) {
    (void)lc_host_setup_metadata_poll(state, approval, &job->metadata);
    if (job->metadata.phase == LC_SETUP_METADATA_PENDING) return;
    if (job->metadata.phase != LC_SETUP_METADATA_READY || !lc_qualification_no_acl(scope->metadata_pins.fd[0])) { lc_qualification_unknown(state, job); return; }
    if (job->cancel_requested) {
      if (!lc_host_scope_seal(state, scope)) { lc_qualification_unknown(state, job); return; }
      job->phase = LC_QUAL_CLOSING; return;
    }
    if (!lc_qualification_network_begin(job)) { lc_qualification_unknown(state, job); return; }
    CC_SHA256(job->metadata.stdout_bytes, (CC_LONG)job->metadata.stdout_size, job->g_sha256);
    job->phase = LC_QUAL_NETWORK_CONTROL; return;
  }
  if (job->cancel_requested && job->phase != LC_QUAL_CLOSING && job->phase != LC_QUAL_BRIDGE) {
    if (!lc_host_scope_seal(state, scope)) { lc_qualification_unknown(state, job); return; }
    job->phase = LC_QUAL_CLOSING;
  }
  if (job->phase == LC_QUAL_NETWORK_CONTROL) {
    if (!lc_qualification_network_poll(job)) { lc_qualification_unknown(state, job); return; }
    if (!job->socket_positive) return;
    if (!lc_qualification_package_files(approval, job) || !lc_qualification_command(state, approval, job, "test")) { lc_qualification_unknown(state, job); return; }
    job->phase = LC_QUAL_TEST; return;
  }
  if (job->phase == LC_QUAL_TEST || job->phase == LC_QUAL_BUILD) {
    if (job->phase == LC_QUAL_TEST && scope->record.phase == LC_HOST_RUNNING &&
        !lc_qualification_observe_detached(approval, job)) { lc_qualification_unknown(state, job); return; }
    if (scope->record.phase != LC_HOST_IDLE) return;
    if (!job->detached_closed) job->detached_closed = lc_qualification_detached_closed(job);
    bool build = job->phase == LC_QUAL_BUILD;
    if (!lc_qualification_evidence(approval, job, build)) { lc_qualification_unknown(state, job); return; }
    if (!build) {
      job->package_test = true;
      if (!lc_qualification_command(state, approval, job, "build")) { lc_qualification_unknown(state, job); return; }
      job->phase = LC_QUAL_BUILD; return;
    }
    job->package_build = true;
    if (!lc_qualification_command(state, approval, job, "flood") || !lc_host_monotonic(&job->flood_started)) { lc_qualification_unknown(state, job); return; }
    job->phase = LC_QUAL_FLOOD; return;
  }
  if (job->phase == LC_QUAL_FLOOD) {
    if (scope->record.phase != LC_HOST_RUNNING || scope->reaped || scope->timed_out) { lc_qualification_unknown(state, job); return; }
    if (now - job->flood_started < 200 || scope->stdout_size < 32768 || lc_host_uid_zero(scope->record.principal.uid)) return;
    job->stop_observed = true;
    if (!lc_host_scope_seal(state, scope)) { lc_qualification_unknown(state, job); return; }
    job->phase = LC_QUAL_CLOSING; return;
  }
  if (job->phase == LC_QUAL_CLOSING || job->phase == LC_QUAL_BRIDGE) {
    if (!scope->released) return;
    if (!lc_qualification_cleanup_tick(state, approval, job)) lc_qualification_unknown(state, job);
  }
}
static inline const char *lc_qualification_stage(uint32_t phase) {
  switch (phase) {
    case LC_QUAL_HISTORY: return "history"; case LC_QUAL_ACQUIRE: return "acquiringWriter";
    case LC_QUAL_METADATA: return "inspectingMetadata"; case LC_QUAL_NETWORK_CONTROL: return "networkControl";
    case LC_QUAL_TEST: return "packageTest"; case LC_QUAL_BUILD: return "packageBuild";
    case LC_QUAL_FLOOD: return "checkingStop"; case LC_QUAL_CLOSING: return "closing";
    case LC_QUAL_BRIDGE: return "awaitingBridge"; case LC_QUAL_PASSED: return "passed";
    case LC_QUAL_CANCELLED: return "cancelled"; default: return "recoveryRequired";
  }
}
static inline xpc_object_t lc_qualification_reply(const lc_host_approval *approval, const lc_host_qualification *job, bool start) {
  const char *state = job->phase == LC_QUAL_UNKNOWN ? "unknown" : job->phase == LC_QUAL_PASSED ? "setupPassed" :
    job->phase == LC_QUAL_CANCELLED ? "setupCancelled" : job->phase == LC_QUAL_BRIDGE ? "setupAwaitingBridge" : "setupRunning";
  xpc_object_t reply = lc_host_reply(state, job->phase == LC_QUAL_UNKNOWN ? "qualificationRecoveryRequired" : "okay");
  lc_host_put(reply, "generation", approval->generation); lc_host_put(reply, "qualificationId", job->id);
  lc_host_put(reply, "stage", lc_qualification_stage(job->phase));
  char digest[65]; lc_host_hex(job->pass_receipt, 32, digest, sizeof(digest)); lc_host_put(reply, "receiptSHA256", digest);
  if (start) lc_host_put(reply, "bridgeNonce", job->bridge_nonce);
  return reply;
}
/* The caller already passed the existing kernel-audit/full-bundle actor owner.
 * Every effect is fixed production setup; no workspace/Turn impersonation and
 * no command, policy, UID, root pathname or toolchain arrives on this protocol. */
static inline xpc_object_t lc_host_setup_request(int state, lc_host_approval *approval, xpc_object_t request,
    const char *operation, lc_host_qualification *job, lc_host_scope *scopes, xpc_connection_t *owners, xpc_connection_t peer) {
  if (!strcmp(operation, "setupQualificationDescribe")) {
    static const char *const fields[] = { "version", "operation" };
    if (!lc_host_fields(request, fields, 2)) return lc_host_reply("unavailable", "invalidRequest");
    xpc_object_t reply = lc_host_reply(approval->setup_authorized && approval->platform_matches ? "setupReady" : "setupBlocked",
      !approval->setup_authorized ? "setupAuthorizationRequired" : !approval->platform_matches ? "setupPlatformMismatch" : "okay");
    lc_host_put(reply, "generation", approval->generation); lc_host_put(reply, "policy", approval->policy); lc_host_put(reply, "policyGeneration", approval->policy_generation);
    char digest[65]; lc_host_hex(approval->manifest_sha256, 32, digest, sizeof(digest)); lc_host_put(reply, "configurationSHA256", digest); return reply;
  }
  char generation[65];
  if (!approval->setup_authorized || !approval->platform_matches || !lc_host_installed_broker_valid(approval) ||
      !lc_host_get(request, "generation", generation, sizeof(generation)) || strcmp(generation, approval->generation)) return lc_host_reply("unavailable", "setupAuthorizationRequired");
  if (!strcmp(operation, "setupQualificationStart")) {
    static const char *const fields[] = { "version", "operation", "generation", "setupPermitId", "namespaceFd" };
    char permit[65];
    if (!lc_host_fields(request, fields, 5) || !lc_host_get(request, "setupPermitId", permit, sizeof(permit)) ||
        strcmp(permit, approval->setup_permit_id) || !lc_host_setup_namespace(approval, request)) return lc_host_reply("unavailable", "setupAuthorizationRequired");
    /* Never reissue the original private bridge nonce to a repeated/lost-ACK
     * caller: a fresh invocation cannot prove closure of the original bridge. */
    if (job->used || approval->qualified) return lc_host_reply("unknown", "setupAlreadyStarted");
    size_t index = LC_HOST_MAX_SCOPES;
    for (size_t i = 0; i < LC_HOST_MAX_SCOPES; i++) if (!scopes[i].used && !owners[i]) { index = i; break; }
    if (index == LC_HOST_MAX_SCOPES) return lc_host_reply("unavailable", "resourceLimit");
    memset(job, 0, sizeof(*job)); job->used = true; job->phase = LC_QUAL_UNKNOWN; job->resource_index = index; job->resource = &scopes[index];
    for (size_t i = 0; i < LC_QUAL_FDS; i++) job->fd[i] = -1;
    for (size_t i = 0; i < LC_HOST_TOOLCHAIN_ROLES; i++) job->tools.fd[i] = -1;
    job->acquisition.reservation_fd = job->acquisition.reservation_directory_fd = -1;
    unsigned char id[32], nonce[32], zero[32] = {0}; arc4random_buf(id, 32); arc4random_buf(nonce, 32);
    lc_host_hex(id, 32, job->id, sizeof(job->id)); lc_host_hex(nonce, 32, job->bridge_nonce, sizeof(job->bridge_nonce));
    if (!lc_qualification_policy(approval) || !lc_host_qualification_toolchain_open(approval, &job->tools) || !lc_host_scan_begin(state, approval->actor, zero, &job->history))
      return lc_qualification_reply(approval, job, true);
    job->original_start = request; xpc_retain(request); owners[index] = peer; xpc_retain(peer);
    job->phase = LC_QUAL_HISTORY; return lc_qualification_reply(approval, job, true);
  }
  bool confirm = !strcmp(operation, "setupQualificationBridgeClosed");
  if (confirm || !strcmp(operation, "setupQualificationStatus") || !strcmp(operation, "setupQualificationCancel")) {
    static const char *const fields[] = { "version", "operation", "generation", "qualificationId", "bridgeNonce" };
    char id[65];
    if (!lc_host_fields(request, fields, confirm ? 5 : 4) || !lc_host_get(request, "qualificationId", id, sizeof(id))) return lc_host_reply("unavailable", "invalidRequest");
    if (!job->used || strcmp(id, job->id)) return lc_host_reply("unknown", "setupQualificationNotStarted");
    if (confirm) {
      char nonce[65];
      if (!lc_host_get(request, "bridgeNonce", nonce, sizeof(nonce)) || strcmp(nonce, job->bridge_nonce)) return lc_host_reply("unavailable", "setupBridgeIdentityConflict");
      if (job->original_peer_disconnected) job->bridge_confirmed = true;
    } else if (!strcmp(operation, "setupQualificationCancel") && job->phase != LC_QUAL_PASSED && job->phase != LC_QUAL_CANCELLED)
      job->cancel_requested = true;
    xpc_object_t reply = lc_qualification_reply(approval, job, false);
    if (confirm) lc_host_put(reply, "bridgeConfirmed", job->bridge_confirmed ? "true" : "false");
    return reply;
  }
  return lc_host_reply("unavailable", "unknownOperation");
}
#endif
