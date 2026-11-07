/* Private LCFM/1 T session. The filesystem owner performs no Git operation.
 * FD3 is the original directory; FD6 is the borrowed writer open description.
 * OPEN suffix: u32 target-leaf length + target, u32 trusted-identity length
 * + identity. Identity is checked before any lock or private-file write.
 * Response T, exists byte,
 * u32 private-directory-name length + name. All names are FD-relative.
 * V verifies ownership, H inspects a root-relative executable (response H, byte
 * 0 absent/not executable, 1 executable, 2 unsupported), P + source leaf publishes,
 * A aborts, Q retains evidence. P/A/Q acknowledge and exit. EOF always retains.
 */
#define TX_NAME 200U
#define TX_ENTRIES 4096U

struct tx_file { unsigned char *bytes; uint32_t length; int exists; struct stat stat; };
struct tx_state {
  int directory, temporary_directory, lock;
  char target[TX_NAME + 1], lock_name[TX_NAME + 6], temporary_name[80];
  struct stat directory_stat, temporary_stat, lock_stat;
  struct tx_file original;
};

static int tx_component(const char *name) {
  return *name && strcmp(name, ".") && strcmp(name, "..") && !strchr(name, '/') && !strchr(name, '\\');
}
static int tx_string(char *out, uint32_t maximum) {
  uint32_t length;
  if (read_u32(&length) || !length || length > maximum || read_exact(0, out, length) || memchr(out, 0, length)) return -1;
  out[length] = 0; return 0;
}
static int tx_open_directory(const char *path) {
  char copy[MAX_PATH_BYTES + 1]; size_t length = strlen(path);
  if (!length || length > MAX_PATH_BYTES || path[0] == '/' || strchr(path, '\\')) return -1;
  memcpy(copy, path, length + 1);
  int current = dup(3); if (current < 0) return -1;
  char *part = copy;
  for (;;) {
    char *slash = strchr(part, '/'); if (slash) *slash = 0;
    if (!tx_component(part)) { close(current); return -1; }
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (next < 0) { close(current); return -1; }
    if (close(current)) { close(next); return -1; }
    current = next; if (!slash) return current; part = slash + 1;
  }
}
static int tx_read(int directory, const char *name, struct tx_file *value) {
  memset(value, 0, sizeof(*value));
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) return errno == ENOENT ? 0 : -1;
  struct stat after; int result = -1;
  if (fstat(fd, &value->stat) || !S_ISREG(value->stat.st_mode) || value->stat.st_nlink != 1 ||
      value->stat.st_uid != geteuid() || (value->stat.st_mode & 07000) || value->stat.st_size < 0 ||
      (uint64_t)value->stat.st_size > MAX_CONTENT) goto done;
  value->length = (uint32_t)value->stat.st_size;
  value->bytes = malloc((size_t)value->length + 1); if (!value->bytes) goto done;
  size_t total = 0;
  while (total <= value->length) {
    if (stopped) goto done;
    ssize_t got = read(fd, value->bytes + total, (size_t)value->length + 1 - total);
    if (got < 0 && errno == EINTR) continue;
    if (got < 0) goto done;
    if (!got) break;
    total += (size_t)got;
  }
  if (total != value->length || fstat(fd, &after) || !same_stat(&value->stat, &after)) goto done;
  value->exists = 1; result = 0;
done:
  if (close(fd)) result = -1;
  if (result) { free(value->bytes); value->bytes = NULL; }
  return result;
}
static int tx_identity(int directory, const char *name, const struct stat *expected) {
  struct stat current;
  return !fstatat(directory, name, &current, AT_SYMLINK_NOFOLLOW) &&
    current.st_dev == expected->st_dev && current.st_ino == expected->st_ino;
}
static int tx_owned(struct tx_state *state, const char *path) {
  int current = tx_open_directory(path); struct stat identity;
  if (current < 0) return 0;
  int good = !fstat(current, &identity) && identity.st_dev == state->directory_stat.st_dev &&
    identity.st_ino == state->directory_stat.st_ino;
  if (close(current)) good = 0;
  return good && tx_identity(state->directory, state->lock_name, &state->lock_stat) &&
    tx_identity(state->directory, state->temporary_name, &state->temporary_stat);
}
static int tx_empty_directory(int directory, unsigned int depth) {
  if (depth > 8) return -1;
  int copy = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (copy < 0) return -1;
  DIR *stream = fdopendir(copy); if (!stream) { close(copy); return -1; }
  int result = 0; unsigned int count = 0;
  for (;;) {
    errno = 0; struct dirent *entry = readdir(stream);
    if (!entry) { if (errno) result = -1; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++count > TX_ENTRIES) { result = -1; break; }
    struct stat info;
    if (fstatat(directory, entry->d_name, &info, AT_SYMLINK_NOFOLLOW)) { result = -1; break; }
    if (S_ISDIR(info.st_mode)) {
      int child = openat(directory, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      if (child < 0) { result = -1; break; }
      int emptied = tx_empty_directory(child, depth + 1);
      if (close(child)) emptied = -1;
      if (emptied || unlinkat(directory, entry->d_name, AT_REMOVEDIR)) { result = -1; break; }
    } else if (unlinkat(directory, entry->d_name, 0)) { result = -1; break; }
  }
  if (closedir(stream)) result = -1;
  return result;
}
static int tx_cleanup(struct tx_state *state, int remove_lock) {
  if (remove_lock && state->lock >= 0) {
    if (!tx_identity(state->directory, state->lock_name, &state->lock_stat) ||
        unlinkat(state->directory, state->lock_name, 0)) return -1;
  }
  if (state->temporary_directory >= 0) {
    if (!tx_identity(state->directory, state->temporary_name, &state->temporary_stat) ||
        tx_empty_directory(state->temporary_directory, 0) ||
        unlinkat(state->directory, state->temporary_name, AT_REMOVEDIR)) return -1;
  }
  return fsync(state->directory);
}
static int tx_executable(const char *path) {
  char copy[MAX_PATH_BYTES + 1], *name; size_t length = strlen(path);
  if (!length || length > MAX_PATH_BYTES || path[0] == '/' || strchr(path, '\\')) return 2;
  memcpy(copy, path, length + 1); name = strrchr(copy, '/');
  int directory;
  if (name) { *name++ = 0; directory = tx_open_directory(copy); }
  else { name = copy; directory = dup(3); }
  if (!tx_component(name)) { if (directory >= 0) close(directory); return 2; }
  if (directory < 0) return errno == ENOENT ? 0 : 2;
  struct stat info; int result;
  if (fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW)) result = errno == ENOENT ? 0 : 2;
  else if (!S_ISREG(info.st_mode)) result = 2;
  else if (faccessat(directory, name, X_OK, 0) == 0) result = 1;
  else result = errno == EACCES ? 0 : 2;
  if (close(directory)) return 2;
  return result;
}
static int tx_entry(const char *path) {
  char copy[MAX_PATH_BYTES + 1], *name; size_t length = strlen(path);
  if (!length || length > MAX_PATH_BYTES || path[0] == '/' || strchr(path, '\\')) return 4;
  memcpy(copy, path, length + 1); name = strrchr(copy, '/');
  int directory;
  if (name) { *name++ = 0; directory = tx_open_directory(copy); }
  else { name = copy; directory = dup(3); }
  if (!tx_component(name)) { if (directory >= 0) close(directory); return 4; }
  if (directory < 0) return errno == ENOENT ? 0 : 4;
  struct stat info; int result;
  if (fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW)) result = errno == ENOENT ? 0 : 4;
  else if (S_ISREG(info.st_mode)) result = 1;
  else if (S_ISDIR(info.st_mode)) result = 2;
  else if (S_ISLNK(info.st_mode)) result = 3;
  else result = 4;
  if (close(directory)) return 4;
  return result;
}
static int run_private_transaction(const char *path) {
  struct tx_state state; memset(&state, 0, sizeof(state));
  state.directory = state.temporary_directory = state.lock = -1;
  int result = 1, started_session = 0;
  struct stat root, lease;
  if (fstat(3, &root) || !S_ISDIR(root.st_mode) || fstat(6, &lease) || !S_ISREG(lease.st_mode))
    return fail(5, "Private transaction requires retained root and writer descriptors");
  if (tx_string(state.target, TX_NAME) || !tx_component(state.target)) return fail(1, "Invalid private transaction target");
  state.directory = tx_open_directory(path);
  if (state.directory < 0 || fstat(state.directory, &state.directory_stat)) {
    result = fail(5, "Private transaction directory must be real and root-relative; linked metadata is unsupported"); goto done;
  }
  char expected_identity[257], actual_identity[256];
  if (tx_string(expected_identity, 256) || format_directory_identity(&root, &state.directory_stat, actual_identity, sizeof(actual_identity)) < 0 ||
      strcmp(expected_identity, actual_identity)) {
    result = fail(2, "Private transaction metadata does not match the trusted identity"); goto done;
  }
  snprintf(state.lock_name, sizeof(state.lock_name), "%s.lock", state.target);
  state.lock = openat(state.directory, state.lock_name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (state.lock < 0) { result = fail(2, "Private transaction lock already exists or cannot be acquired"); goto done; }
  if (fstat(state.lock, &state.lock_stat) || tx_read(state.directory, state.target, &state.original)) {
    result = fail(5, "Private transaction source is not a stable supported file"); goto setup_failed;
  }
  unsigned char random[16];
  int entropy = open("/dev/urandom", O_RDONLY | O_NOFOLLOW);
  if (entropy < 0) { result = fail(3, "Unable to create private transaction name"); goto setup_failed; }
  int random_error = read_exact(entropy, random, sizeof(random));
  if (close(entropy)) random_error = -1;
  if (random_error) { result = fail(3, "Unable to create private transaction name"); goto setup_failed; }
  strcpy(state.temporary_name, ".legioncode-transaction-");
  size_t prefix = strlen(state.temporary_name);
  for (size_t index = 0; index < sizeof(random); index++) snprintf(state.temporary_name + prefix + index * 2, 3, "%02x", random[index]);
  if (mkdirat(state.directory, state.temporary_name, 0700) ||
      (state.temporary_directory = openat(state.directory, state.temporary_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)) < 0 ||
      fstat(state.temporary_directory, &state.temporary_stat)) {
    result = fail(3, "Unable to create private transaction directory"); goto setup_failed;
  }
  if (state.original.exists) {
    int copy = openat(state.temporary_directory, state.target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (copy < 0) { result = fail(3, "Unable to snapshot transaction source"); goto setup_failed; }
    int copied = write_exact(copy, state.original.bytes, state.original.length) || fsync(copy);
    if (close(copy)) copied = 1;
    if (copied) { result = fail(3, "Unable to persist transaction snapshot"); goto setup_failed; }
  }
  if (fsync(state.temporary_directory) || fsync(state.directory) || !tx_owned(&state, path)) {
    result = fail(2, "Private transaction directory ownership changed"); goto setup_failed;
  }
  unsigned char header[2] = {'T', (unsigned char)state.original.exists};
  if (write_exact(1, header, 2) || write_u32((uint32_t)strlen(state.temporary_name)) ||
      write_exact(1, state.temporary_name, strlen(state.temporary_name))) goto done;
  started_session = 1;
  for (;;) {
    unsigned char command;
    if (read_exact(0, &command, 1)) { result = 0; break; } /* Owner loss retains evidence. */
    if (command == 'Q') { result = write_exact(1, "Q", 1) ? 1 : 0; break; }
    if (!tx_owned(&state, path)) { result = fail(2, "Private transaction ownership changed"); break; }
    if (command == 'V') { if (write_exact(1, "V", 1)) break; continue; }
    if (command == 'H') {
      char candidate[MAX_PATH_BYTES + 1];
      if (tx_string(candidate, MAX_PATH_BYTES)) { result = fail(1, "Invalid private executable inspection path"); break; }
      unsigned char answer[2] = {'H', (unsigned char)tx_executable(candidate)};
      if (write_exact(1, answer, 2)) break; continue;
    }
    if (command == 'K') {
      char candidate[MAX_PATH_BYTES + 1];
      if (tx_string(candidate, MAX_PATH_BYTES)) { result = fail(1, "Invalid private entry inspection path"); break; }
      unsigned char answer[2] = {'K', (unsigned char)tx_entry(candidate)};
      if (write_exact(1, answer, 2)) break; continue;
    }
    if (command == 'A') {
      result = tx_cleanup(&state, 1) ? fail(3, "Private transaction abort cleanup failed") : (write_exact(1, "A", 1) ? 1 : 0); break;
    }
    if (command == 'P') {
      char source[TX_NAME + 1]; struct tx_file next, current;
      if (tx_string(source, TX_NAME) || !tx_component(source)) { result = fail(1, "Invalid private publication source"); break; }
      if (tx_read(state.temporary_directory, source, &next)) { result = fail(5, "Private publication source is not stable"); break; }
      int changed = tx_read(state.directory, state.target, &current) || !next.exists ||
        state.original.exists != current.exists || state.original.length != current.length ||
        (state.original.exists && (!same_stat(&state.original.stat, &current.stat) ||
          memcmp(state.original.bytes, current.bytes, current.length)));
      free(current.bytes);
      if (changed) { free(next.bytes); result = fail(2, "Transaction target changed before publication"); break; }
      if (ftruncate(state.lock, 0) || lseek(state.lock, 0, SEEK_SET) < 0 ||
          write_exact(state.lock, next.bytes, next.length) ||
          fchmod(state.lock, state.original.exists ? state.original.stat.st_mode & 0777 : 0600) || fsync(state.lock) ||
          !tx_owned(&state, path) || renameat(state.directory, state.lock_name, state.directory, state.target)) {
        free(next.bytes); result = fail(3, "Private transaction publication outcome is uncertain"); break;
      }
      free(next.bytes);
      if (fsync(state.directory) || tx_cleanup(&state, 0)) { result = fail(3, "Published transaction cleanup or sync failed"); break; }
      result = write_exact(1, "P", 1) ? 1 : 0; break;
    }
    result = fail(1, "Invalid private transaction command"); break;
  }
  goto done;
setup_failed:
  if (!started_session && state.lock >= 0 && tx_cleanup(&state, 1)) result = 2;
done:
  if (state.lock >= 0 && close(state.lock)) result = 2;
  if (state.temporary_directory >= 0 && close(state.temporary_directory)) result = 2;
  if (state.directory >= 0 && close(state.directory)) result = 2;
  free(state.original.bytes);
  return result;
}
