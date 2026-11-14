#ifndef LEGIONCODE_HOST_SETUP_WRITER_H
#define LEGIONCODE_HOST_SETUP_WRITER_H
/* Included only by the existing privileged adapter. Its three borrow-only APIs
 * above/below this setup entry remain unchanged. No codec or lock is replaced. */
#include "legioncode-host-contract.h"
#include "legioncode-host-actor.h"
#include <grp.h>
#include <pwd.h>
#include <sys/wait.h>

static bool lc_setup_original_files(int fence, int root, int directory, const lc_host_writer_binding *binding) {
  struct stat r, d, f, named; unsigned char encoded[272]; char name[64];
  if (!encode_binding(binding, encoded) || fstat(root, &r) || !S_ISDIR(r.st_mode) || r.st_uid != binding->actor_uid || !same_file(&r, binding->root) ||
      fstat(directory, &d) || !S_ISDIR(d.st_mode) || d.st_uid != binding->actor_uid || (d.st_mode & 0777) != 0700 || !same_file(&d, binding->namespace) ||
      fstat(fence, &f) || !S_ISREG(f.st_mode) || f.st_uid != binding->actor_uid || (f.st_mode & 0777) != 0600 || f.st_nlink != 1 || !same_file(&f, binding->fence)) return false;
  int flags = fcntl(fence, F_GETFL);
  if (flags < 0 || (flags & O_ACCMODE) != O_RDWR || (flags & O_APPEND)) return false;
  snprintf(name, sizeof(name), "%" PRIx64 "-%" PRIx64 ".lease", binding->root.device, binding->root.inode);
  return !fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) && S_ISREG(named.st_mode) &&
    named.st_uid == binding->actor_uid && (named.st_mode & 0777) == 0600 && named.st_nlink == 1 && same_file(&named, binding->fence);
}
static bool lc_setup_reservation(lc_writer_setup_acquisition *state, uint32_t actor) {
  struct stat record, directory, named; char path[PATH_MAX], name[80];
  if (getuid() || geteuid() || fstat(state->reservation_fd, &record) || !S_ISREG(record.st_mode) ||
      record.st_uid || (record.st_mode & 0777) != 0600 || record.st_nlink != 1 || !same_file(&record, state->reservation_identity) ||
      record.st_size < (off_t)(sizeof(lc_host_resource_record_prefix) + 32) || record.st_size > 65536 ||
      fstat(state->reservation_directory_fd, &directory) || !S_ISDIR(directory.st_mode) || directory.st_uid ||
      (directory.st_mode & 0777) != 0700 || !same_file(&directory, state->reservation_directory_identity) ||
      fcntl(state->reservation_directory_fd, F_GETPATH, path) || strcmp(path, LC_HOST_RESOURCE_STATE_DIRECTORY) ||
      !lc_host_protected_acl(state->reservation_fd) || !lc_host_protected_acl(state->reservation_directory_fd)) return false;
  unsigned char *bytes = calloc(1, (size_t)record.st_size); if (!bytes) return false;
  bool okay = lc_io(state->reservation_fd, bytes, (size_t)record.st_size, 0, false);
  lc_host_resource_record_prefix prefix; memset(&prefix, 0, sizeof(prefix)); memcpy(&prefix, bytes, sizeof(prefix));
  unsigned char digest[32];
  okay = okay && prefix.version == LC_HOST_RESOURCE_RECORD_VERSION && prefix.bytes == record.st_size &&
    prefix.purpose == LC_HOST_RESOURCE_SETUP_QUALIFICATION && prefix.phase == 1 && !prefix.command_count && !prefix.cleanup_closed &&
    prefix.digest_offset >= sizeof(prefix) && prefix.digest_offset == prefix.bytes - 32 && prefix.binding.actor_uid == actor &&
    !memcmp(&prefix.binding, &state->binding, sizeof(state->binding));
  if (okay) {
    CC_SHA256(bytes, prefix.digest_offset, digest);
    okay = !memcmp(digest, bytes + prefix.digest_offset, 32) && !memcmp(digest, state->reservation_sha256, 32);
  }
  char capability[65]; lc_host_hex(prefix.binding.capability_sha256, 32, capability, sizeof(capability));
  snprintf(name, sizeof(name), "resource.%s", capability);
  okay = okay && !fstatat(state->reservation_directory_fd, name, &named, AT_SYMLINK_NOFOLLOW) &&
    S_ISREG(named.st_mode) && named.st_dev == record.st_dev && named.st_ino == record.st_ino &&
    lc_sync(state->reservation_fd) && lc_sync(state->reservation_directory_fd);
  free(bytes); return okay;
}
void lc_writer_setup_qualification_cancel(lc_writer_setup_acquisition *state) {
  if (!state || state->version != 1 || state->phase == LC_WRITER_SETUP_ACQUIRED) return;
  state->phase = LC_WRITER_SETUP_UNKNOWN;
  if (state->child > 0 && !state->child_reaped && !state->child_identity_lost) (void)kill((pid_t)state->child, SIGKILL);
}
bool lc_writer_setup_qualification_poll(lc_writer_setup_acquisition *state) {
  if (!state || state->version != 1) return false;
  if (state->phase == LC_WRITER_SETUP_ACQUIRED) return true;
  if (state->phase != LC_WRITER_SETUP_PENDING && state->phase != LC_WRITER_SETUP_UNKNOWN) return false;
  uint64_t now;
  if (!lc_clock(&now) || now >= state->deadline_milliseconds) lc_writer_setup_qualification_cancel(state);
  if (state->control_fd >= 0 && state->control_nonblocking) {
    for (unsigned int reads = 0; reads < 4; reads++) {
      unsigned char bytes[16]; ssize_t count = read(state->control_fd, bytes, sizeof(bytes));
      if (count < 0 && errno == EINTR) continue;
      if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
      if (count < 0) { lc_writer_setup_qualification_cancel(state); break; }
      if (!count) {
        state->control_eof = true; int original = state->control_fd; state->control_fd = -1;
        if (close(original)) lc_writer_setup_qualification_cancel(state); else state->control_closed = true;
        break;
      }
      if ((size_t)count > sizeof(state->report) - state->report_bytes) { lc_writer_setup_qualification_cancel(state); break; }
      memcpy(state->report + state->report_bytes, bytes, (size_t)count); state->report_bytes += (uint32_t)count;
    }
  }
  if (state->child > 0 && !state->child_reaped && !state->child_identity_lost) {
    pid_t reaped = waitpid((pid_t)state->child, &state->child_status, WNOHANG);
    if (reaped == state->child) state->child_reaped = true;
    else if (reaped < 0 && errno != EINTR) { state->child_identity_lost = true; state->phase = LC_WRITER_SETUP_UNKNOWN; }
  }
  if (state->phase == LC_WRITER_SETUP_UNKNOWN || !state->child_reaped || !state->control_eof || !state->control_closed || !state->control_write_closed) return false;
  static const unsigned char expected[8] = { 'L','C','Q','A',1,0,0,1 };
  lc_host_wal_scope scope;
  if (state->report_bytes != sizeof(expected) || memcmp(state->report, expected, sizeof(expected)) ||
      !WIFEXITED(state->child_status) || WEXITSTATUS(state->child_status) ||
      !original_scope(state->fence_fd, state->root_fd, state->namespace_fd, &state->binding, &scope)) {
    state->phase = LC_WRITER_SETUP_UNKNOWN; return false;
  }
  state->report_valid = true; state->phase = LC_WRITER_SETUP_ACQUIRED; return true;
}
bool lc_writer_setup_qualification_acquire(int fence, int root, int directory, uint32_t actor,
                                          lc_writer_setup_acquisition *state) {
  if (!state || state->version != 1 || state->phase != LC_WRITER_SETUP_NOT_STARTED) return false;
  state->root_fd = root; state->fence_fd = fence; state->namespace_fd = directory;
  state->control_fd = state->control_write_fd = -1;
  struct passwd account, *found = NULL; char account_bytes[16384]; struct stat original;
  if (!lc_setup_reservation(state, actor) || !lc_setup_original_files(fence, root, directory, &state->binding) ||
      getpwuid_r(actor, &account, account_bytes, sizeof(account_bytes), &found) || !found || account.pw_uid != actor ||
      fstat(fence, &original) || !lc_clock(&state->deadline_milliseconds)) { state->phase = LC_WRITER_SETUP_UNKNOWN; return false; }
  int gate[2]; if (pipe(gate)) { state->phase = LC_WRITER_SETUP_UNKNOWN; return false; }
  state->control_fd = gate[0]; state->control_write_fd = gate[1]; state->deadline_milliseconds += 6000;
  state->control_nonblocking = fcntl(gate[0], F_SETFL, O_NONBLOCK) == 0;
  if (!state->control_nonblocking || fcntl(gate[0], F_SETFD, FD_CLOEXEC) || fcntl(gate[1], F_SETFD, FD_CLOEXEC)) {
    /* Retain the original read descriptor; no fence is closed or unlocked. */
    state->control_write_close_attempted = true;
    state->control_write_closed = close(gate[1]) == 0;
    state->phase = LC_WRITER_SETUP_UNKNOWN; return false;
  }
  pid_t child = fork();
  if (!child) {
    long maximum = sysconf(_SC_OPEN_MAX);
    if (maximum < 4 || maximum > INT_MAX) _exit(126);
    for (int fd = 0; fd < maximum; fd++) if (fd != root && fd != fence && fd != directory && fd != gate[1]) close(fd);
    bool okay = lc_host_drop_actor(actor, account.pw_gid) && lc_intent_acquire(fence, root, directory, original.st_size == 0);
    unsigned char result[8] = { 'L','C','Q','A',1,0,0,okay ? 1 : 0 };
    ssize_t written; do { written = write(gate[1], result, sizeof(result)); } while (written < 0 && errno == EINTR);
    bool closed = close(gate[1]) == 0;
    _exit(okay && written == sizeof(result) && closed ? 0 : 78);
  }
  state->child = child;
  state->control_write_close_attempted = true;
  state->control_write_closed = close(gate[1]) == 0;
  if (!state->control_write_closed || child < 0) { state->phase = LC_WRITER_SETUP_UNKNOWN; return false; }
  state->phase = LC_WRITER_SETUP_PENDING;
  return lc_writer_setup_qualification_poll(state);
}
#endif
