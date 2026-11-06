#define _POSIX_C_SOURCE 200809L
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <errno.h>

/* LCFM/1, no arguments: trusted root directory object is inherited at FD 3.
 * OPEN: "LCFM", byte 1, byte 'R' (read) or 'M' (mutate), u32be path length, path.
 * INSPECTED: 'I', byte exists, u32be source length, source bytes. R then exits.
 * M continues: STAGE 'S', u32be next length, next bytes; STAGED response 'S'.
 * COMMIT 'C'; COMMITTED response 'C' only after directory sync.
 * ERROR 'E', byte code, u32be message length <=1024, message (no file contents).
 * Codes: 1 invalid input, 2 conflict, 3 I/O/uncertain commit, 4 cancelled,
 * 5 unsupported target. The runtime owns identity, policy, approval, lease,
 * capture and lifecycle. This helper owns bounded FD-relative filesystem I/O.
 * renameat is an atomic directory-entry replacement, not external-writer CAS.
 */
#define MAX_CONTENT (4U * 1024U * 1024U)
#define MAX_PATH_BYTES 500U
static volatile sig_atomic_t stopped = 0;
static int parent_fd = -1, staged_fd = -1;
static char requested_path[MAX_PATH_BYTES + 1], temporary[96] = {0};
static unsigned char *staged_content = NULL;
static uint32_t staged_length = 0;
static struct stat staged_stat;

static void on_stop(int sig) { (void)sig; stopped = 1; }
static int read_exact(int fd, void *buf, size_t length) {
  unsigned char *cursor = buf;
  while (length) {
    if (stopped) return -1;
    ssize_t got = read(fd, cursor, length);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) return -1;
    cursor += got; length -= (size_t)got;
  }
  return 0;
}
static int write_exact(int fd, const void *buf, size_t length) {
  const unsigned char *cursor = buf;
  while (length) {
    ssize_t sent = write(fd, cursor, length);
    if (sent < 0 && errno == EINTR) continue;
    if (sent <= 0) return -1;
    cursor += sent; length -= (size_t)sent;
  }
  return 0;
}
static int read_u32(uint32_t *value) {
  unsigned char bytes[4];
  if (read_exact(0, bytes, 4)) return -1;
  *value = ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
    ((uint32_t)bytes[2] << 8) | bytes[3];
  return 0;
}
static int write_u32(uint32_t value) {
  unsigned char bytes[4] = {(unsigned char)(value >> 24), (unsigned char)(value >> 16),
    (unsigned char)(value >> 8), (unsigned char)value};
  return write_exact(1, bytes, 4);
}
static int fail(unsigned char code, const char *message) {
  unsigned char prefix[2] = {'E', code};
  size_t size = strlen(message); if (size > 1024) size = 1024;
  (void)write_exact(1, prefix, 2); (void)write_u32((uint32_t)size);
  (void)write_exact(1, message, size); return 1;
}
static int cancelled(void) { return fail(4, "Native filesystem operation cancelled before commit"); }
static int same_stat(const struct stat *a, const struct stat *b) {
#if defined(__APPLE__)
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size &&
    a->st_mode == b->st_mode && a->st_nlink == b->st_nlink &&
    a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
    a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
#else
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size &&
    a->st_mode == b->st_mode && a->st_nlink == b->st_nlink &&
    a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
    a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
#endif
}
static int open_parent(const char *path, char *name) {
  struct stat root; char copy[MAX_PATH_BYTES + 1];
  if (fstat(3, &root) || !S_ISDIR(root.st_mode)) return -1;
  memcpy(copy, path, strlen(path) + 1);
  int fd = dup(3); if (fd < 0) return -1;
  char *part = copy;
  for (;;) {
    char *slash = strchr(part, '/'); if (slash) *slash = 0;
    if (!*part || !strcmp(part, ".") || !strcmp(part, "..") || !strcasecmp(part, ".git") ||
        !strncasecmp(part, ".legioncode-edit-", 17) || strchr(part, '\\')) { close(fd); return -1; }
    if (!slash) { strcpy(name, part); return fd; }
    int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (next < 0) { close(fd); return -1; }
    if (close(fd)) { close(next); return -1; }
    fd = next; part = slash + 1;
  }
}
static int parent_still_rooted(void) {
  char name[MAX_PATH_BYTES + 1]; struct stat held, current;
  int fd = open_parent(requested_path, name); if (fd < 0) return 0;
  int matches = !fstat(parent_fd, &held) && !fstat(fd, &current) &&
    held.st_dev == current.st_dev && held.st_ino == current.st_ino;
  if (close(fd)) return 0;
  return matches;
}
static int read_target(const char *name, unsigned char **content, uint32_t *length,
    struct stat *identity, int *exists, int mutation) {
  int fd = openat(parent_fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) {
    if (errno == ENOENT) { *exists = 0; *length = 0; *content = NULL; return 0; }
    return -1;
  }
  int result = -1; struct stat after;
  if (fstat(fd, identity) || !S_ISREG(identity->st_mode) || identity->st_size < 0 ||
      (uint64_t)identity->st_size > MAX_CONTENT || (mutation &&
      (identity->st_nlink != 1 || identity->st_uid != geteuid() || (identity->st_mode & 07000)))) goto done;
  uint32_t expected = (uint32_t)identity->st_size;
  unsigned char *bytes = malloc((size_t)expected + 1); if (!bytes) goto done;
  size_t total = 0;
  while (total <= expected) {
    if (stopped) { free(bytes); goto done; }
    ssize_t got = read(fd, bytes + total, (size_t)expected + 1 - total);
    if (got < 0 && errno == EINTR) continue;
    if (got < 0) { free(bytes); goto done; }
    if (!got) break;
    total += (size_t)got;
  }
  if (total != expected || fstat(fd, &after) || !same_stat(identity, &after)) { free(bytes); goto done; }
  *content = bytes; *length = expected; *exists = 1; result = 0;
done:
  if (close(fd) && result == 0) { free(*content); *content = NULL; result = -1; }
  return result;
}
static int create_stage(void) {
  unsigned char random[16];
  int entropy = open("/dev/urandom", O_RDONLY | O_NOFOLLOW);
  if (entropy < 0) return -1;
  int result = read_exact(entropy, random, sizeof(random));
  if (close(entropy)) result = -1;
  if (result) return -1;
  strcpy(temporary, ".legioncode-edit-");
  size_t prefix = strlen(temporary);
  for (size_t i = 0; i < sizeof(random); i++) snprintf(temporary + prefix + i * 2, 3, "%02x", random[i]);
  strcat(temporary, ".tmp");
  staged_fd = openat(parent_fd, temporary, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (staged_fd < 0) temporary[0] = 0;
  return staged_fd;
}
static int verify_stage(const char *name, int strict) {
  struct stat named, held;
  if (fstatat(parent_fd, name, &named, AT_SYMLINK_NOFOLLOW) || fstat(staged_fd, &held) ||
      !S_ISREG(named.st_mode) || named.st_dev != held.st_dev || named.st_ino != held.st_ino ||
      held.st_dev != staged_stat.st_dev || held.st_ino != staged_stat.st_ino ||
      held.st_size != (off_t)staged_length || held.st_nlink != 1 ||
      held.st_mode != staged_stat.st_mode || (strict && !same_stat(&staged_stat, &held))) return 0;
  unsigned char chunk[16384]; size_t offset = 0;
  while (offset < staged_length) {
    size_t wanted = staged_length - offset; if (wanted > sizeof(chunk)) wanted = sizeof(chunk);
    ssize_t got = pread(staged_fd, chunk, wanted, (off_t)offset);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0 || memcmp(chunk, staged_content + offset, (size_t)got)) return 0;
    offset += (size_t)got;
  }
  struct stat after;
  return !fstat(staged_fd, &after) && same_stat(&held, &after);
}
static int run(void) {
  unsigned char header[6]; uint32_t path_length; char name[MAX_PATH_BYTES + 1];
  if (read_exact(0, header, 6) || memcmp(header, "LCFM\1", 5) || (header[5] != 'R' && header[5] != 'M') ||
      read_u32(&path_length) || !path_length || path_length > MAX_PATH_BYTES ||
      read_exact(0, requested_path, path_length)) return stopped ? cancelled() : fail(1, "Invalid native filesystem protocol");
  if (memchr(requested_path, 0, path_length)) return fail(1, "NUL is not allowed in a workspace path");
  requested_path[path_length] = 0;
  parent_fd = open_parent(requested_path, name);
  if (parent_fd < 0) return fail(5, "Workspace parent must exist without symlinks or protected components");
  unsigned char *original = NULL; uint32_t original_length = 0; struct stat original_stat; int existed = 0;
  if (read_target(name, &original, &original_length, &original_stat, &existed, header[5] == 'M'))
    return stopped ? cancelled() : fail(5, "Target is not a stable supported regular file");
  if (!parent_still_rooted()) { free(original); return fail(2, "Read parent no longer belongs to the granted root"); }
  unsigned char inspected[2] = {'I', (unsigned char)existed};
  if (write_exact(1, inspected, 2) || write_u32(original_length) || write_exact(1, original, original_length)) { free(original); return 1; }
  if (header[5] == 'R') { free(original); return 0; }
  unsigned char command;
  if (read_exact(0, &command, 1) || command != 'S' || read_u32(&staged_length) || staged_length > MAX_CONTENT) {
    free(original); return stopped ? cancelled() : fail(1, "Invalid staged file frame");
  }
  staged_content = malloc((size_t)staged_length + 1);
  if (!staged_content) { free(original); return fail(3, "Unable to allocate staged file"); }
  if (read_exact(0, staged_content, staged_length)) { free(original); return stopped ? cancelled() : fail(1, "Incomplete staged file frame"); }
  if (!parent_still_rooted() || create_stage() < 0) { free(original); return stopped ? cancelled() : fail(3, "Unable to create rooted staged file"); }
  if (write_exact(staged_fd, staged_content, staged_length) ||
      (existed && fchown(staged_fd, (uid_t)-1, original_stat.st_gid)) ||
      (existed && fchmod(staged_fd, original_stat.st_mode & 0777)) || fsync(staged_fd) || fstat(staged_fd, &staged_stat)) {
    free(original); return stopped ? cancelled() : fail(3, "Unable to persist staged file");
  }
  if (stopped) { free(original); return cancelled(); }
  if (write_exact(1, "S", 1) || read_exact(0, &command, 1) || command != 'C') {
    free(original); return stopped ? cancelled() : fail(1, "Commit was not authorized");
  }
  unsigned char *current = NULL; uint32_t current_length = 0; struct stat current_stat; int current_exists = 0;
  int changed = !parent_still_rooted() || read_target(name, &current, &current_length, &current_stat, &current_exists, 1) ||
    existed != current_exists || original_length != current_length ||
    (existed && (!same_stat(&original_stat, &current_stat) || memcmp(original, current, original_length))) || !verify_stage(temporary, 1);
  free(original); free(current);
  if (stopped) return cancelled();
  if (changed) return fail(2, "Edit conflict: parent, target or staged content changed before commit");
  if (existed) {
    if (renameat(parent_fd, temporary, parent_fd, name)) return fail(3, "Atomic file replacement failed");
    temporary[0] = 0;
  } else {
    if (linkat(parent_fd, temporary, parent_fd, name, 0)) return fail(2, "New file already exists or cannot be created");
    if (unlinkat(parent_fd, temporary, 0)) return fail(3, "Created file but staged-link cleanup failed");
    temporary[0] = 0;
  }
  /* Stop racing commit cannot reverse it. Check actual published inode/bytes and sync. */
  if (!verify_stage(name, 0) || fsync(parent_fd)) return fail(3, "File commit outcome requires workspace capture");
  return write_exact(1, "C", 1) ? 1 : 0;
}
int main(void) {
  struct sigaction action; memset(&action, 0, sizeof(action)); action.sa_handler = on_stop;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL) || signal(SIGPIPE, SIG_IGN) == SIG_ERR) return 1;
  int result = run();
  if (temporary[0] && parent_fd >= 0 && staged_fd >= 0) {
    struct stat named, held;
    if (!fstatat(parent_fd, temporary, &named, AT_SYMLINK_NOFOLLOW) && !fstat(staged_fd, &held) &&
        named.st_dev == held.st_dev && named.st_ino == held.st_ino && unlinkat(parent_fd, temporary, 0)) result = 2;
  }
  if (staged_fd >= 0 && close(staged_fd)) result = 2;
  if (parent_fd >= 0 && close(parent_fd)) result = 2;
  free(staged_content); return result;
}
