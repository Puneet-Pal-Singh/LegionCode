#ifndef LEGIONCODE_HOST_SETUP_METADATA_H
#define LEGIONCODE_HOST_SETUP_METADATA_H
#include "legioncode-host-setup-auth.h"
#include "legioncode-host-scope.h"
#include "legioncode-host-actor.h"

#define LC_HOST_SETUP_FILESYSTEM_HELPER "Contents/Resources/native/legioncode-fs-helper"
typedef enum { LC_SETUP_METADATA_NEW, LC_SETUP_METADATA_PENDING, LC_SETUP_METADATA_READY, LC_SETUP_METADATA_UNKNOWN } lc_setup_metadata_phase;
/* Same setup resource owns this ORIGINAL child and every channel until exact
 * reap/EOF/close. Failure never frees the root/fence/namespace or invents a G. */
typedef struct {
  uint32_t version, phase;
  lc_host_scope *resource;
  lc_host_writer_binding binding;
  lc_writer_setup_acquisition *acquisition;
  pid_t child; int child_status;
  bool child_reaped, child_identity_lost, stdout_eof, stderr_eof;
  bool stdin_close_attempted, stdin_closed;
  int descriptor[7], original_descriptor[7];
  bool descriptor_nonblocking[7];
  unsigned char descriptor_close[7]; /* 0 retained, 1 confirmed, 2 uncertain. */
  int resource_directory;
  bool resource_unknown_recorded;
  unsigned char stdout_bytes[16384], stderr_bytes[2048];
  size_t stdout_size, stderr_size;
  uint64_t deadline;
  char helper_path[PATH_MAX];
} lc_host_setup_metadata_execution;

static inline bool lc_host_setup_helper(const lc_host_approval *approval, char path[PATH_MAX]) {
  CFTypeRef raw = CFDictionaryGetValue(approval->manifest, CFSTR("ResourceSHA256"));
  char expected[65];
  if (!raw || CFGetTypeID(raw) != CFDictionaryGetTypeID() ||
      !lc_host_text(CFDictionaryGetValue(raw, CFSTR(LC_HOST_SETUP_FILESYSTEM_HELPER)), expected, sizeof(expected)) ||
      snprintf(path, PATH_MAX, "%s/%s", approval->bundle, LC_HOST_SETUP_FILESYSTEM_HELPER) >= PATH_MAX ||
      !lc_host_bundle_valid((lc_host_approval *)approval) || !lc_host_sha_file(path, expected)) return false;
  struct stat st;
  if (lstat(path, &st) || !S_ISREG(st.st_mode) || (st.st_uid != 0 && st.st_uid != approval->actor) || (st.st_mode & 06022) || !(st.st_mode & 0111)) return false;
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const unsigned char *)path, (CFIndex)strlen(path), false);
  SecStaticCodeRef code = NULL; bool okay = url && SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess;
  if (url) CFRelease(url);
  /* Exact manifest identity, including ad-hoc preview signatures. No Developer
   * ID/team/Apple anchor requirement is introduced by this transport. */
  okay = okay && SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures, NULL) == errSecSuccess &&
    lc_host_code_hash(code, CFDictionaryGetValue(approval->manifest, CFSTR("FilesystemHelperCDHash")));
  if (code) CFRelease(code); return okay;
}
static inline bool lc_host_setup_metadata_pins(const lc_host_approval *approval, const lc_host_setup_metadata_execution *state) {
  const lc_host_scope *resource = state->resource; struct stat root, fence, namespace;
  const lc_writer_setup_acquisition *acquisition = state->acquisition;
  return resource && resource->used && !resource->released && !resource->sealed &&
    resource->record.purpose == LC_HOST_RESOURCE_SETUP_QUALIFICATION && resource->record.phase == LC_HOST_IDLE &&
    !resource->record.command_count && !resource->record.cleanup_closed &&
    resource->record.binding.actor_uid == approval->actor && !memcmp(&resource->record.binding, &state->binding, sizeof(state->binding)) &&
    !memcmp(resource->record.setup_manifest_sha256, approval->manifest_sha256, 32) && !strcmp(resource->record.origin_generation, approval->generation) &&
    acquisition && acquisition->phase == LC_WRITER_SETUP_ACQUIRED && acquisition->root_fd == resource->root &&
    acquisition->fence_fd == resource->fence && acquisition->namespace_fd == resource->namespace &&
    !memcmp(&acquisition->binding, &state->binding, sizeof(state->binding)) &&
    !fstat(resource->root, &root) && S_ISDIR(root.st_mode) && root.st_uid == approval->actor &&
    (uint64_t)root.st_dev == state->binding.root.device && (uint64_t)root.st_ino == state->binding.root.inode &&
    !fstat(resource->fence, &fence) && S_ISREG(fence.st_mode) && fence.st_uid == approval->actor && (fence.st_mode & 0777) == 0600 && fence.st_nlink == 1 &&
    (uint64_t)fence.st_dev == state->binding.fence.device && (uint64_t)fence.st_ino == state->binding.fence.inode &&
    !fstat(resource->namespace, &namespace) && S_ISDIR(namespace.st_mode) && namespace.st_uid == approval->actor && (namespace.st_mode & 0777) == 0700 &&
    (uint64_t)namespace.st_dev == state->binding.namespace.device && (uint64_t)namespace.st_ino == state->binding.namespace.inode &&
    (uint64_t)namespace.st_dev == approval->writer_namespace.device && (uint64_t)namespace.st_ino == approval->writer_namespace.inode;
}
static inline void lc_host_setup_metadata_cancel(lc_host_setup_metadata_execution *state) {
  if (!state || state->version != 1 || state->phase == LC_SETUP_METADATA_READY) return;
  state->phase = LC_SETUP_METADATA_UNKNOWN;
  if (!state->resource_unknown_recorded && state->resource &&
      state->resource->record.purpose == LC_HOST_RESOURCE_SETUP_QUALIFICATION &&
      !memcmp(&state->resource->record.binding, &state->binding, sizeof(state->binding))) {
    state->resource_unknown_recorded = true;
    lc_host_scope_unknown(state->resource_directory, state->resource);
  }
  if (state->child > 0 && !state->child_reaped && !state->child_identity_lost) (void)kill(state->child, SIGKILL);
}
static inline bool lc_host_setup_metadata_string(const unsigned char *bytes, size_t size, size_t *at,
    xpc_object_t result, const char *key, size_t maximum) {
  if (size - *at < 4) return false;
  uint32_t length = lc_host_read32(bytes + *at); *at += 4;
  if (length > maximum || length > size - *at) return false;
  xpc_dictionary_set_data(result, key, bytes + *at, length); *at += length; return true;
}
/* Bounded LCFM/1 G framing adapter ONLY. The bundled canonical helper performs
 * the actual Git resolver/storage walk; existing metadata_open verifies tuples. */
static inline bool lc_host_setup_metadata_decode(const lc_host_setup_metadata_execution *state, lc_host_metadata *metadata) {
  const unsigned char *bytes = state->stdout_bytes; size_t size = state->stdout_size, at = 2;
  if (size < 2 || bytes[0] != 'G' || bytes[1] > 1) return false;
  xpc_object_t fields = xpc_dictionary_create(NULL, NULL, 0); bool okay = fields != NULL;
  const char *first[] = { "gitDirectory", "commonDirectory", "backlinkPath" };
  for (size_t i = 0; okay && i < 3; i++) okay = lc_host_setup_metadata_string(bytes, size, &at, fields, first[i], 500);
  okay = okay && lc_host_setup_metadata_string(bytes, size, &at, fields, "metadataIdentity", 512) && at < size && bytes[at++] == 1;
  const char *storage[] = { "objectsDirectory", "packDirectory", "infoDirectory", "refsDirectory", "commonLogsDirectory", "worktreeLogsDirectory", "repositoryInfoDirectory" };
  for (size_t i = 0; okay && i < 7; i++) okay = lc_host_setup_metadata_string(bytes, size, &at, fields, storage[i], 500);
  okay = okay && lc_host_setup_metadata_string(bytes, size, &at, fields, "storageIdentity", 512) && at == size && lc_host_metadata_read(fields, metadata) &&
    ((bytes[1] == 1) == (metadata->paths[2][0] != 0));
  if (fields) xpc_release(fields); return okay;
}
static inline bool lc_host_setup_metadata_close(lc_host_setup_metadata_execution *state, size_t index) {
  if (state->descriptor_close[index]) return state->descriptor_close[index] == 1;
  int original = state->descriptor[index];
  state->descriptor[index] = -1; state->descriptor_close[index] = 2;
  if (original < 0 || close(original)) return false;
  state->descriptor_close[index] = 1; return true;
}
static inline bool lc_host_setup_metadata_pipe(lc_host_setup_metadata_execution *state, size_t read_index, size_t write_index) {
  int pair[2]; if (pipe(pair)) return false;
  state->descriptor[read_index] = state->original_descriptor[read_index] = pair[0];
  state->descriptor[write_index] = state->original_descriptor[write_index] = pair[1];
  if (read_index != 0) state->descriptor_nonblocking[read_index] = fcntl(pair[0], F_SETFL, O_NONBLOCK) == 0;
  return (read_index == 0 || state->descriptor_nonblocking[read_index]) &&
    !fcntl(pair[0], F_SETFD, FD_CLOEXEC) && !fcntl(pair[1], F_SETFD, FD_CLOEXEC);
}
static inline bool lc_host_setup_metadata_drain(lc_host_setup_metadata_execution *state, size_t index,
    unsigned char *bytes, size_t capacity, size_t *size, bool *eof) {
  if (state->descriptor[index] < 0) return *eof;
  if (!state->descriptor_nonblocking[index]) return false;
  for (unsigned int i = 0; i < 4; i++) {
    unsigned char buffer[4096]; ssize_t count = read(state->descriptor[index], buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return true;
    if (count < 0) return false;
    if (!count) {
      if (!lc_host_setup_metadata_close(state, index)) return false;
      *eof = true; return true;
    }
    if ((size_t)count > capacity - *size) return false;
    memcpy(bytes + *size, buffer, (size_t)count); *size += (size_t)count;
  }
  return true;
}
static inline bool lc_host_setup_metadata_poll(int directory, const lc_host_approval *approval, lc_host_setup_metadata_execution *state) {
  if (!state || state->version != 1) return false;
  if (state->phase == LC_SETUP_METADATA_READY)
    return lc_host_setup_metadata_pins(approval, state) && state->resource->record.setup_metadata_inspected &&
      lc_host_metadata_current(&state->resource->record.metadata, &state->resource->metadata_pins) &&
      lc_host_metadata_receipt_matches(&state->resource->record.metadata, &state->resource->metadata_pins, state->resource->root);
  if (state->phase != LC_SETUP_METADATA_PENDING && state->phase != LC_SETUP_METADATA_UNKNOWN) return false;
  uint64_t now;
  if (!lc_host_monotonic(&now) || now >= state->deadline || !lc_host_setup_metadata_pins(approval, state) || state->resource->record.setup_metadata_inspected) lc_host_setup_metadata_cancel(state);
  if (!lc_host_setup_metadata_drain(state, 2, state->stdout_bytes, sizeof(state->stdout_bytes), &state->stdout_size, &state->stdout_eof) ||
      !lc_host_setup_metadata_drain(state, 4, state->stderr_bytes, sizeof(state->stderr_bytes), &state->stderr_size, &state->stderr_eof)) lc_host_setup_metadata_cancel(state);
  if (state->child > 0 && !state->child_reaped && !state->child_identity_lost) {
    pid_t reaped = waitpid(state->child, &state->child_status, WNOHANG);
    if (reaped == state->child) state->child_reaped = true;
    else if (reaped < 0 && errno != EINTR) { state->child_identity_lost = true; state->phase = LC_SETUP_METADATA_UNKNOWN; }
  }
  if (state->phase == LC_SETUP_METADATA_UNKNOWN || !state->stdin_closed || !state->stdout_eof || !state->stderr_eof || !state->child_reaped) return false;
  for (size_t i = 0; i < 7; i++) if (state->descriptor_close[i] != 1) { lc_host_setup_metadata_cancel(state); return false; }
  lc_host_metadata metadata; lc_host_metadata_pins pins; char helper[PATH_MAX];
  if (!WIFEXITED(state->child_status) || WEXITSTATUS(state->child_status) || state->stderr_size ||
      !lc_host_setup_metadata_pins(approval, state) || !lc_host_setup_helper(approval, helper) || strcmp(helper, state->helper_path) ||
      !lc_host_setup_metadata_decode(state, &metadata) || !lc_host_metadata_open(&metadata, &pins, state->resource->record.root_path, state->resource->root)) {
    lc_host_setup_metadata_cancel(state); return false;
  }
  /* Physical helper closure plus actual stat-tuple verification precedes the
   * protected record upgrade. Original metadata pins transfer to this resource. */
  state->resource->record.metadata = metadata; state->resource->metadata_pins = pins;
  state->resource->record.setup_metadata_inspected = 1;
  state->resource->access.metadata = &state->resource->record.metadata;
  state->resource->access.metadata_pins = &state->resource->metadata_pins;
  if (!lc_host_scope_save(directory, state->resource)) { lc_host_setup_metadata_cancel(state); return false; }
  state->phase = LC_SETUP_METADATA_READY; return true;
}
static inline bool lc_host_setup_metadata_begin(int directory, const lc_host_approval *approval, lc_host_scope *resource,
    lc_writer_setup_acquisition *acquisition, lc_host_setup_metadata_execution *state) {
  if (!state || !resource || state->version != 1 || state->phase != LC_SETUP_METADATA_NEW) return false;
  state->resource_directory = directory;
  state->resource = resource; state->acquisition = acquisition; state->binding = resource->record.binding;
  for (size_t i = 0; i < 7; i++) state->descriptor[i] = state->original_descriptor[i] = -1;
  lc_host_scope_record record; struct passwd actor, *found = NULL; char account[16384]; unsigned char scope[32];
  if (!lc_host_setup_metadata_pins(approval, state) || resource->record.setup_metadata_started || resource->record.setup_metadata_inspected ||
      !lc_host_record_read(directory, resource->name, &record) || memcmp(&record, &resource->record, sizeof(record)) ||
      !lc_host_setup_scope_sha256(approval, record.setup_nonce, &record.binding, record.boot, scope) || memcmp(scope, record.binding.scope_sha256, 32) ||
      !lc_host_setup_helper(approval, state->helper_path) || getpwuid_r(approval->actor, &actor, account, sizeof(account), &found) || !found || actor.pw_uid != approval->actor ||
      !lc_host_monotonic(&state->deadline)) { state->phase = LC_SETUP_METADATA_UNKNOWN; return false; }
  /* Persist this one-shot helper start before the first pipe/child effect. */
  resource->record.setup_metadata_started = 1;
  if (!lc_host_scope_save(directory, resource)) { lc_host_setup_metadata_cancel(state); return false; }
  if (!lc_host_setup_metadata_pipe(state, 0, 1) || !lc_host_setup_metadata_pipe(state, 2, 3) || !lc_host_setup_metadata_pipe(state, 4, 5)) {
    lc_host_setup_metadata_cancel(state); return false;
  }
  state->deadline += 6000;
  state->descriptor[6] = state->original_descriptor[6] = fcntl(resource->root, F_DUPFD_CLOEXEC, 20);
  if (state->descriptor[6] < 0) {
    lc_host_setup_metadata_cancel(state); return false;
  }
  pid_t child = fork();
  if (!child) {
    long maximum = sysconf(_SC_OPEN_MAX);
    int input = fcntl(state->descriptor[0], F_DUPFD_CLOEXEC, 20);
    int output = fcntl(state->descriptor[3], F_DUPFD_CLOEXEC, 20);
    int error = fcntl(state->descriptor[5], F_DUPFD_CLOEXEC, 20);
    if (maximum < 4 || maximum > INT_MAX || input < 0 || output < 0 || error < 0 ||
        dup2(input, 0) < 0 || dup2(output, 1) < 0 || dup2(error, 2) < 0 || dup2(state->descriptor[6], 3) < 0) _exit(126);
    for (int fd = 4; fd < maximum; fd++) close(fd);
    if (!lc_host_drop_actor(approval->actor, actor.pw_gid)) _exit(126);
    char *argv[] = { state->helper_path, NULL }; char *environment[] = { NULL };
    execve(argv[0], argv, environment); _exit(127);
  }
  state->child = child;
  bool closed = true; const size_t parent_ends[] = { 0, 3, 5, 6 };
  for (size_t i = 0; i < 4; i++) if (!lc_host_setup_metadata_close(state, parent_ends[i])) closed = false;
  if (child < 0 || !closed) { lc_host_setup_metadata_cancel(state); return false; }
  static const unsigned char request[] = { 'L','C','F','M',1,'G',0,0,0,13,'.','g','i','t','/','m','u','t','a','t','i','o','n' };
  ssize_t written; do { written = write(state->descriptor[1], request, sizeof(request)); } while (written < 0 && errno == EINTR);
  state->stdin_close_attempted = true; state->stdin_closed = lc_host_setup_metadata_close(state, 1);
  if (written != sizeof(request) || !state->stdin_closed) { lc_host_setup_metadata_cancel(state); return false; }
  state->phase = LC_SETUP_METADATA_PENDING;
  return lc_host_setup_metadata_poll(directory, approval, state);
}
#endif
