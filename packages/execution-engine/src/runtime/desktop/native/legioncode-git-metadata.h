/* Runtime-private Git layout resolution. Ordinary file tools never call this
 * walker: Git's bounded gitdir/commondir records may legitimately contain '..'.
 * All components are opened without following symlinks. These retained native
 * handles support identity checks/cleanup, not atomic namespace binding for Git.
 */
#define METADATA_ID_BYTES 512U
struct git_metadata {
  int directory, common;
  int linked;
  struct stat root_stat, gitfile_stat, directory_stat, common_stat;
  char directory_path[MAX_PATH_BYTES + 1], common_path[MAX_PATH_BYTES + 1];
  char backlink_path[MAX_PATH_BYTES + 1], identity[METADATA_ID_BYTES + 1];
};
struct git_storage {
  char paths[7][MAX_PATH_BYTES + 1], identity[METADATA_ID_BYTES + 1];
};
static int metadata_close(struct git_metadata *metadata) {
  int error = 0;
  if (metadata->common >= 0 && close(metadata->common)) error = -1;
  if (metadata->directory >= 0 && close(metadata->directory)) error = -1;
  metadata->common = metadata->directory = -1;
  return error;
}
static int metadata_same(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}
static int metadata_path(int fd, char *output) {
#if defined(__APPLE__)
  char path[1024];
  if (fcntl(fd, F_GETPATH, path) || path[0] != '/' || strlen(path) > MAX_PATH_BYTES) return -1;
  strcpy(output, path); return 0;
#else
  (void)fd; (void)output; return -1;
#endif
}
static int metadata_open_directory(int base, const char *path) {
  size_t length = strlen(path);
  if (!length || length > MAX_PATH_BYTES || strchr(path, '\\')) return -1;
  int current = path[0] == '/' ? open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW) : dup(base);
  if (current < 0) return -1;
  char copy[MAX_PATH_BYTES + 1]; strcpy(copy, path);
  char *part = copy + (path[0] == '/');
  while (*part) {
    char *slash = strchr(part, '/'); if (slash) *slash = 0;
    if (!*part) { close(current); return -1; }
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (next < 0) { close(current); return -1; }
    if (close(current)) { close(next); return -1; }
    current = next; if (!slash) break; part = slash + 1;
  }
  return current;
}
static int metadata_open_file(int base, const char *path) {
  size_t length = strlen(path);
  if (!length || length > MAX_PATH_BYTES || strchr(path, '\\')) return -1;
  char copy[MAX_PATH_BYTES + 1]; strcpy(copy, path);
  char *name = strrchr(copy, '/'); int directory;
  if (name) {
    *name++ = 0;
    directory = metadata_open_directory(base, *copy ? copy : "/");
  } else { name = copy; directory = dup(base); }
  if (directory < 0 || !*name || !strcmp(name, ".") || !strcmp(name, "..")) {
    if (directory >= 0) close(directory); return -1;
  }
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (close(directory)) { if (fd >= 0) close(fd); return -1; }
  return fd;
}
static int metadata_record(int directory, const char *name, const char *prefix, char *value, struct stat *identity) {
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) return -1;
  char bytes[MAX_PATH_BYTES + 16]; struct stat after; int result = -1;
  if (fstat(fd, identity) || !S_ISREG(identity->st_mode) || identity->st_nlink != 1 ||
      identity->st_size <= 0 || (uint64_t)identity->st_size >= sizeof(bytes)) goto done;
  size_t length = (size_t)identity->st_size;
  if (read_exact(fd, bytes, length) || fstat(fd, &after) || !same_stat(identity, &after) || memchr(bytes, 0, length)) goto done;
  if (length && bytes[length - 1] == '\n') length--;
  if (length && bytes[length - 1] == '\r') length--;
  bytes[length] = 0;
  size_t prefix_length = strlen(prefix);
  if (length <= prefix_length || strncmp(bytes, prefix, prefix_length) ||
      strchr(bytes, '\n') || strchr(bytes, '\r') || length - prefix_length > MAX_PATH_BYTES) goto done;
  strcpy(value, bytes + prefix_length); result = 0;
done:
  if (close(fd)) result = -1;
  return result;
}
static int metadata_append_identity(char *output, size_t capacity, const struct stat *value) {
  uintmax_t seconds = 0, nanoseconds = 0;
#if defined(__APPLE__)
  seconds = (uintmax_t)value->st_birthtimespec.tv_sec;
  nanoseconds = (uintmax_t)value->st_birthtimespec.tv_nsec;
#endif
  size_t used = strlen(output);
  int length = snprintf(output + used, capacity - used, ":%jx:%jx:%jx:%jx",
    (uintmax_t)value->st_dev, (uintmax_t)value->st_ino, seconds, nanoseconds);
  return length < 0 || (size_t)length >= capacity - used ? -1 : 0;
}
static int resolve_git_metadata(struct git_metadata *metadata) {
  memset(metadata, 0, sizeof(*metadata)); metadata->directory = metadata->common = -1;
  if (fstat(3, &metadata->root_stat) || !S_ISDIR(metadata->root_stat.st_mode) ||
      fstatat(3, ".git", &metadata->gitfile_stat, AT_SYMLINK_NOFOLLOW)) return -1;
  if (S_ISDIR(metadata->gitfile_stat.st_mode)) {
    metadata->directory = openat(3, ".git", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (metadata->directory < 0 || fstat(metadata->directory, &metadata->directory_stat) ||
        !metadata_same(&metadata->gitfile_stat, &metadata->directory_stat)) goto failed;
    struct stat unexpected;
    if (!fstatat(metadata->directory, "commondir", &unexpected, AT_SYMLINK_NOFOLLOW) || errno != ENOENT) goto failed;
    metadata->common = dup(metadata->directory);
    metadata->common_stat = metadata->directory_stat;
    if (metadata->common < 0) goto failed;
    strcpy(metadata->identity, "gitdir-v1");
    if (metadata_append_identity(metadata->identity, sizeof(metadata->identity), &metadata->root_stat) ||
        metadata_append_identity(metadata->identity, sizeof(metadata->identity), &metadata->directory_stat)) goto failed;
    /* I and ordinary T remain available on Linux; G needs real native paths. */
    (void)metadata_path(metadata->directory, metadata->directory_path);
    strcpy(metadata->common_path, metadata->directory_path);
    return 0;
  }
  if (!S_ISREG(metadata->gitfile_stat.st_mode)) goto failed;
  metadata->linked = 1;
  char target[MAX_PATH_BYTES + 1], common[MAX_PATH_BYTES + 1], backlink[MAX_PATH_BYTES + 1];
  struct stat gitfile, common_record, backlink_record, backlink_stat, worktrees_stat, parent_stat;
  if (metadata_record(3, ".git", "gitdir: ", target, &gitfile) ||
      !same_stat(&gitfile, &metadata->gitfile_stat)) goto failed;
  metadata->directory = metadata_open_directory(3, target);
  if (metadata->directory < 0 || fstat(metadata->directory, &metadata->directory_stat) ||
      metadata_record(metadata->directory, "commondir", "", common, &common_record)) goto failed;
  metadata->common = metadata_open_directory(metadata->directory, common);
  if (metadata->common < 0 || fstat(metadata->common, &metadata->common_stat) ||
      metadata_record(metadata->directory, "gitdir", "", backlink, &backlink_record)) goto failed;
  int backlink_fd = metadata_open_file(metadata->directory, backlink);
  if (backlink_fd < 0) goto failed;
  int bad = fstat(backlink_fd, &backlink_stat) || !same_stat(&backlink_stat, &gitfile) ||
    metadata_path(backlink_fd, metadata->backlink_path);
  if (close(backlink_fd)) bad = 1;
  if (bad) goto failed;
  int worktrees = openat(metadata->common, "worktrees", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  int parent = openat(metadata->directory, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  bad = worktrees < 0 || parent < 0 || fstat(worktrees, &worktrees_stat) || fstat(parent, &parent_stat) ||
    !metadata_same(&worktrees_stat, &parent_stat);
  if (worktrees >= 0 && close(worktrees)) bad = 1;
  if (parent >= 0 && close(parent)) bad = 1;
  if (bad || metadata_path(metadata->directory, metadata->directory_path) ||
      metadata_path(metadata->common, metadata->common_path)) goto failed;
  strcpy(metadata->identity, "gitdir-v2");
  if (metadata_append_identity(metadata->identity, sizeof(metadata->identity), &metadata->root_stat) ||
      metadata_append_identity(metadata->identity, sizeof(metadata->identity), &gitfile) ||
      metadata_append_identity(metadata->identity, sizeof(metadata->identity), &metadata->directory_stat) ||
      metadata_append_identity(metadata->identity, sizeof(metadata->identity), &metadata->common_stat)) goto failed;
  return 0;
failed:
  (void)metadata_close(metadata); return -1;
}
/* This is a bounded names/stat walk, never a pack or loose-object content read.
 * Association-only queries do not scan storage. Concurrent namespace changes
 * remain subject to the approved trusted-host contract, not an atomic snapshot. */
static int metadata_walk(int directory, unsigned int depth, unsigned int *records) {
  if (depth > 16) return -1;
  int copy = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (copy < 0) return -1;
  DIR *stream = fdopendir(copy); if (!stream) { close(copy); return -1; }
  int result = 0;
  for (;;) {
    if (stopped) { result = -1; break; }
    errno = 0; struct dirent *entry = readdir(stream);
    if (!entry) { if (errno) result = -1; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    struct stat value;
    if (++*records > 100000 || fstatat(directory, entry->d_name, &value, AT_SYMLINK_NOFOLLOW)) { result = -1; break; }
    if (S_ISDIR(value.st_mode)) {
      int child = openat(directory, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      struct stat opened;
      int bad = child < 0 || fstat(child, &opened) || !metadata_same(&value, &opened) || metadata_walk(child, depth + 1, records);
      if (child >= 0 && close(child)) bad = 1;
      if (bad) { result = -1; break; }
    } else if (!S_ISREG(value.st_mode)) { result = -1; break; }
  }
  if (closedir(stream)) result = -1;
  return result;
}
static int metadata_storage(const struct git_metadata *metadata, struct git_storage *storage, int scan) {
  memset(storage, 0, sizeof(*storage));
  int descriptors[7] = {-1, -1, -1, -1, -1, -1, -1}, result = -1;
  const char *names[] = {"objects", "objects/pack", "objects/info", "refs", "logs", "logs", "info"};
  struct stat reftable;
  if (!fstatat(metadata->common, "reftable", &reftable, AT_SYMLINK_NOFOLLOW) || errno != ENOENT) goto done;
  strcpy(storage->identity, "gitstorage-v1");
  for (size_t index = 0; index < 7; index++) {
    int base = index == 5 ? metadata->directory : metadata->common;
    const char *base_path = index == 5 ? metadata->directory_path : metadata->common_path;
    if (!*base_path || snprintf(storage->paths[index], sizeof(storage->paths[index]), "%s/%s", base_path, names[index]) >= (int)sizeof(storage->paths[index])) goto done;
    struct stat value; memset(&value, 0, sizeof(value));
    descriptors[index] = metadata_open_directory(base, names[index]);
    if (descriptors[index] < 0) {
      if (index < 4 || errno != ENOENT) goto done;
    } else if (fstat(descriptors[index], &value) || !S_ISDIR(value.st_mode)) goto done;
    /* Logs may be created by the first commit; validate their scope without
     * treating legitimate creation as replacement of an existing authority. */
    if ((index < 4 || index == 6) && metadata_append_identity(storage->identity, sizeof(storage->identity), &value)) goto done;
  }
  struct stat alternates;
  if (!fstatat(descriptors[2], "alternates", &alternates, AT_SYMLINK_NOFOLLOW)) {
    if (!S_ISREG(alternates.st_mode) || alternates.st_size != 0) goto done;
  } else if (errno != ENOENT) goto done;
  if (descriptors[6] >= 0) {
    struct stat grafts;
    if (!fstatat(descriptors[6], "grafts", &grafts, AT_SYMLINK_NOFOLLOW)) {
      if (!S_ISREG(grafts.st_mode) || grafts.st_size != 0) goto done;
    } else if (errno != ENOENT) goto done;
  }
  if (scan) {
    unsigned int records = 0;
    for (size_t index = 0; index < 7; index++) {
      if (index == 1 || index == 2 || (index == 5 && metadata_same(&metadata->directory_stat, &metadata->common_stat))) continue;
      if (descriptors[index] >= 0 && metadata_walk(descriptors[index], 0, &records)) goto done;
    }
  }
  result = 0;
done:
  for (size_t index = 0; index < 7; index++) if (descriptors[index] >= 0 && close(descriptors[index])) result = -1;
  return result;
}
static int inspect_git_metadata(int layout) {
  int mutation = layout && !strcmp(requested_path, ".git/mutation");
  if (strcmp(requested_path, ".git") && !mutation) return fail(1, "Invalid metadata inspection target");
  struct git_metadata metadata;
  if (resolve_git_metadata(&metadata)) return fail(5, "Git metadata layout is unavailable or unsupported");
  int result = 1;
  /* Legacy I callers know no external metadata/protected-root graph. They must
   * remain ordinary-only until migrated to the protected G owner. */
  if (!layout && metadata.linked) {
    result = fail(5, "Linked metadata requires the private protected layout resolver"); goto done;
  }
  if (layout && (!*metadata.directory_path || !*metadata.common_path)) {
    result = fail(5, "Git metadata paths require native Darwin directory inspection"); goto done;
  }
  struct git_storage storage;
  if (mutation && metadata_storage(&metadata, &storage, 1)) {
    result = fail(5, "Writable Git storage is redirected, borrowed or unsupported"); goto done;
  }
  if (write_exact(1, layout ? "G" : "J", 1)) goto done;
  if (layout) {
    unsigned char linked = (unsigned char)metadata.linked;
    if (write_exact(1, &linked, 1)) goto done;
    const char *paths[] = {metadata.directory_path, metadata.common_path, metadata.backlink_path};
    for (size_t index = 0; index < 3; index++)
      if (write_u32((uint32_t)strlen(paths[index])) || write_exact(1, paths[index], strlen(paths[index]))) goto done;
  }
  if (write_u32((uint32_t)strlen(metadata.identity)) || write_exact(1, metadata.identity, strlen(metadata.identity))) goto done;
  if (layout) {
    unsigned char present = (unsigned char)mutation;
    if (write_exact(1, &present, 1)) goto done;
    if (mutation) {
      for (size_t index = 0; index < 7; index++)
        if (write_u32((uint32_t)strlen(storage.paths[index])) || write_exact(1, storage.paths[index], strlen(storage.paths[index]))) goto done;
      if (write_u32((uint32_t)strlen(storage.identity)) || write_exact(1, storage.identity, strlen(storage.identity))) goto done;
    }
  }
  result = 0;
done:
  if (metadata_close(&metadata)) result = 2;
  return result;
}
