#ifndef LEGIONCODE_NATIVE_INSTALLER_COPY_H
#define LEGIONCODE_NATIVE_INSTALLER_COPY_H
#include <dirent.h>
#include <pwd.h>

typedef struct { uid_t actor; size_t entries; uint64_t bytes; } lc_install_copy_budget;
static bool cfg_readable(const struct stat *st, uid_t actor, bool directory) {
  mode_t required = directory ? S_IRUSR | S_IXUSR : S_IRUSR;
  if ((st->st_mode & (S_ISUID | S_ISGID)) || (st->st_uid != 0 && st->st_uid != actor)) return false;
  if (st->st_uid == 0) required = directory ? S_IROTH | S_IXOTH : S_IROTH;
  return (st->st_mode & required) == required;
}
/* Mode bits alone are insufficient: a deny-read/search ACL must not be
 * bypassed by the privileged snapshotter. Reject such source ACLs conservatively. */
static bool cfg_source_acl(int fd, bool directory) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT;
  bool okay = !acl_valid(acl); acl_entry_t entry; int position = ACL_FIRST_ENTRY;
  while (okay) {
    errno = 0; int result = acl_get_entry(acl, position, &entry); position = ACL_NEXT_ENTRY;
    if (result) { okay = result == -1 && errno == EINVAL; break; }
    acl_tag_t tag; acl_permset_t permissions;
    okay = !acl_get_tag_type(entry, &tag) && !acl_get_permset(entry, &permissions);
    if (okay && tag == ACL_EXTENDED_DENY) {
      int read = acl_get_perm_np(permissions, ACL_READ_DATA), execute = acl_get_perm_np(permissions, ACL_EXECUTE);
      okay = read == 0 && (directory ? execute == 0 : execute >= 0);
    }
  }
  acl_free(acl); return okay;
}
/* Never use root's ability to read private source files on behalf of the actor.
 * Every original component is held/opened without following an alias. */
static int cfg_source_open(const char *path, uid_t actor, bool directory) {
  char copy[PATH_MAX], canonical[PATH_MAX];
  if (!lc_host_absolute(path) || !realpath(path, canonical) || strcmp(path, canonical)) return -1;
  strcpy(copy, path); int held = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (held < 0) return -1;
  char *save = NULL, *part = strtok_r(copy + 1, "/", &save);
  while (part) {
    char *next = strtok_r(NULL, "/", &save); struct stat st;
    int fd = openat(held, part, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | ((next || directory) ? O_DIRECTORY : 0));
    bool okay = fd >= 0 && !fstat(fd, &st) &&
      ((next || directory) ? S_ISDIR(st.st_mode) : S_ISREG(st.st_mode)) && cfg_readable(&st, actor, next || directory) && cfg_source_acl(fd, next || directory);
    if (close(held)) okay = false;
    if (!okay) { if (fd >= 0) close(fd); return -1; }
    held = fd; part = next;
  }
  return held;
}
static bool cfg_same_source(const struct stat *before, const struct stat *after) {
  return before->st_dev == after->st_dev && before->st_ino == after->st_ino && before->st_uid == after->st_uid &&
    before->st_mode == after->st_mode && before->st_size == after->st_size &&
    before->st_mtimespec.tv_sec == after->st_mtimespec.tv_sec && before->st_mtimespec.tv_nsec == after->st_mtimespec.tv_nsec &&
    before->st_ctimespec.tv_sec == after->st_ctimespec.tv_sec && before->st_ctimespec.tv_nsec == after->st_ctimespec.tv_nsec;
}
static bool cfg_copy_file(int source, int output, const char *name, lc_install_copy_budget *budget, uint64_t limit) {
  struct stat before, after;
  if (++budget->entries > 20000 || fstat(source, &before) || !S_ISREG(before.st_mode) || before.st_nlink != 1 ||
      !cfg_readable(&before, budget->actor, false) || !cfg_source_acl(source, false) || before.st_size < 0 || (uint64_t)before.st_size > limit) return false;
  int fd = openat(output, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  acl_t empty = acl_init(0); bool okay = empty && !acl_set_fd_np(fd, empty, ACL_TYPE_EXTENDED);
  if (empty) acl_free(empty);
  uint64_t copied = 0;
  while (okay) {
    unsigned char bytes[32768]; ssize_t n = read(source, bytes, sizeof(bytes));
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) { okay = false; break; }
    if (!n) break;
    if ((uint64_t)n > limit - copied || (uint64_t)n > 512U * 1024U * 1024U - budget->bytes) { okay = false; break; }
    okay = lc_host_io(fd, bytes, (size_t)n, true); copied += (uint64_t)n; budget->bytes += (uint64_t)n;
  }
  okay = okay && copied == (uint64_t)before.st_size && !fstat(source, &after) && cfg_same_source(&before, &after) &&
    !fchmod(fd, before.st_mode & 0111 ? 0555 : 0444) && lc_host_protected_fd(fd, false) && lc_host_sync(fd);
  if (close(fd)) okay = false;
  return okay && lc_host_sync(output);
}
/* Resolve a relative alias lexically, then prove every target component from
 * the original npm root FD. No alias, including an intermediate parent, is followed. */
static bool cfg_alias_path(const char *parent, const char *literal, char output[PATH_MAX]) {
  size_t literal_length = strlen(literal);
  if (!literal_length || literal[0] == '/' || literal[literal_length - 1] == '/') return false;
  char combined[PATH_MAX];
  if (snprintf(combined, sizeof(combined), "%s%s%s", parent, parent[0] ? "/" : "", literal) >= (int)sizeof(combined)) return false;
  for (const unsigned char *p = (const unsigned char *)combined; *p; p++) if (*p < 32 || *p == 127) return false;
  size_t positions[128], count = 0, length = 0, prefix = strlen(parent) + (parent[0] ? 1 : 0);
  bool target_started = false; output[0] = 0;
  char *save = NULL, *part = strtok_r(combined, "/", &save);
  while (part) {
    bool literal_part = (size_t)(part - combined) >= prefix;
    if (!strcmp(part, "..")) {
      /* Do not cancel an unproved intermediate literal component: following
       * its alias before /.. would differ from lexical normalization. */
      if (!count || (literal_part && target_started)) return false;
      length = positions[--count]; output[length] = 0;
    } else if (strcmp(part, ".")) {
      if (literal_part) target_started = true;
      size_t size = strlen(part), previous = length;
      if (count >= 128 || size > NAME_MAX || length + size + 2 > PATH_MAX) return false;
      if (length) output[length++] = '/';
      memcpy(output + length, part, size + 1); length += size; positions[count++] = previous;
    }
    part = strtok_r(NULL, "/", &save);
  }
  return count > 0;
}
static bool cfg_alias_target(int root, const char *relative, uid_t actor) {
  char path[PATH_MAX]; strcpy(path, relative);
  int held = openat(root, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (held < 0) return false;
  char *save = NULL, *part = strtok_r(path, "/", &save); bool okay = part != NULL;
  while (okay && part) {
    char *next = strtok_r(NULL, "/", &save); struct stat st;
    int fd = openat(held, part, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (next ? O_DIRECTORY : 0));
    okay = fd >= 0 && !fstat(fd, &st) && cfg_readable(&st, actor, next != NULL) && cfg_source_acl(fd, next != NULL) &&
      (next ? S_ISDIR(st.st_mode) : (S_ISREG(st.st_mode) && st.st_nlink == 1 && st.st_size >= 0 && st.st_size <= 16U * 1024U * 1024U));
    if (close(held)) okay = false;
    held = fd; part = next;
  }
  if (held >= 0 && close(held)) okay = false; return okay;
}
static bool cfg_alias(int root, int source, int output, const char *parent, const char *name,
    const struct stat *before, lc_install_copy_budget *budget) {
  char literal[PATH_MAX], target[PATH_MAX]; struct stat after;
  if (++budget->entries > 20000 || (before->st_uid != 0 && before->st_uid != budget->actor) || before->st_size <= 0 || before->st_size >= PATH_MAX) return false;
  ssize_t length = readlinkat(source, name, literal, sizeof(literal) - 1);
  if (length <= 0 || length >= (ssize_t)sizeof(literal) - 1 || length != before->st_size) return false;
  literal[length] = 0;
  bool okay = cfg_alias_path(parent, literal, target) && cfg_alias_target(root, target, budget->actor) &&
    !fstatat(source, name, &after, AT_SYMLINK_NOFOLLOW) && cfg_same_source(before, &after);
  if (okay && output >= 0) {
    /* symlinkat has exclusive creation semantics and does not follow its target.
     * Only our newly created protected output directory is mutated. */
    okay = !symlinkat(literal, output, name) && !fstatat(output, name, &after, AT_SYMLINK_NOFOLLOW) &&
      S_ISLNK(after.st_mode) && after.st_uid == 0 && lc_host_sync(output);
  }
  return okay;
}
/* One traversal policy serves read-only preflight, copying, and final validation
 * of the complete immutable snapshot. output == -1 performs no mutation. */
static bool cfg_tree(int root, int source, int output, const char *relative, lc_install_copy_budget *budget, unsigned depth) {
  struct stat before, after;
  if (depth > 32 || ++budget->entries > 20000 || fstat(source, &before) || !S_ISDIR(before.st_mode) ||
      !cfg_readable(&before, budget->actor, true) || !cfg_source_acl(source, true)) return false;
  int scan = openat(source, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (scan < 0) return false;
  DIR *directory = fdopendir(scan); if (!directory) { close(scan); return false; }
  bool okay = true;
  for (;;) {
    errno = 0; struct dirent *entry = readdir(directory);
    if (!entry) { if (errno) okay = false; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    struct stat named, actual;
    if (fstatat(source, entry->d_name, &named, AT_SYMLINK_NOFOLLOW)) { okay = false; break; }
    if (S_ISLNK(named.st_mode)) {
      okay = cfg_alias(root, source, output, relative, entry->d_name, &named, budget);
      if (!okay) break;
      continue;
    }
    if (!S_ISDIR(named.st_mode) && !S_ISREG(named.st_mode)) { okay = false; break; }
    int held = openat(source, entry->d_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (S_ISDIR(named.st_mode) ? O_DIRECTORY : 0));
    okay = held >= 0 && !fstat(held, &actual) && cfg_same_source(&named, &actual);
    if (okay && S_ISDIR(actual.st_mode)) {
      char child_path[PATH_MAX];
      okay = snprintf(child_path, sizeof(child_path), "%s%s%s", relative, relative[0] ? "/" : "", entry->d_name) < (int)sizeof(child_path);
      int child = okay && output >= 0 ? install_directory(output, entry->d_name, 0755) : -1;
      okay = okay && (output < 0 || child >= 0) && cfg_tree(root, held, child, child_path, budget, depth + 1);
      if (child >= 0 && close(child)) okay = false;
    } else if (okay && output >= 0) okay = cfg_copy_file(held, output, entry->d_name, budget, 16U * 1024U * 1024U);
    else if (okay) {
      okay = ++budget->entries <= 20000 && S_ISREG(actual.st_mode) && actual.st_nlink == 1 && actual.st_size >= 0 &&
        actual.st_size <= 16U * 1024U * 1024U && cfg_readable(&actual, budget->actor, false) && cfg_source_acl(held, false) &&
        (uint64_t)actual.st_size <= 512U * 1024U * 1024U - budget->bytes;
      if (okay) budget->bytes += (uint64_t)actual.st_size;
    }
    if (held >= 0 && close(held)) okay = false;
    if (!okay) break;
  }
  if (closedir(directory)) okay = false;
  return okay && !fstat(source, &after) && cfg_same_source(&before, &after) && (output < 0 || lc_host_sync(output));
}
static bool cfg_validate_tree(int source, lc_install_copy_budget *budget) {
  return cfg_tree(source, source, -1, "", budget, 0);
}
static bool cfg_copy_tree(int source, int output, lc_install_copy_budget *budget) {
  if (!cfg_tree(source, source, output, "", budget, 0)) return false;
  lc_install_copy_budget immutable = { 0, 0, 0 };
  return cfg_validate_tree(output, &immutable);
}

/* Parse JSON as data with JavaScriptCore's JSON-only entry point; never evaluate
 * npm JavaScript or invoke its selected Node binary under root. */
#include <JavaScriptCore/JavaScriptCore.h>
static bool cfg_npm_package(int npm, uid_t actor) {
  int fd = openat(npm, "package.json", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC); struct stat st;
  if (fd < 0) return false;
  struct stat original = { 0 }, final;
  bool okay = !fstat(fd, &st) && S_ISREG(st.st_mode) && st.st_nlink == 1 &&
    cfg_readable(&st, actor, false) && cfg_source_acl(fd, false) && st.st_size > 0 && st.st_size <= 65536;
  if (okay) original = st;
  char *bytes = okay ? calloc(1, (size_t)st.st_size + 1) : NULL;
  okay = bytes && lc_host_io(fd, bytes, (size_t)st.st_size, false) && !memchr(bytes, 0, (size_t)st.st_size) &&
    !fstat(fd, &final) && cfg_same_source(&original, &final);
  if (close(fd)) okay = false;
  JSGlobalContextRef context = okay ? JSGlobalContextCreate(NULL) : NULL;
  JSStringRef json = context ? JSStringCreateWithUTF8CString(bytes) : NULL;
  JSValueRef value = json ? JSValueMakeFromJSONString(context, json) : NULL;
  JSStringRef key = JSStringCreateWithUTF8CString("name"), expected = JSStringCreateWithUTF8CString("npm");
  JSObjectRef object = value && JSValueIsObject(context, value) ? JSValueToObject(context, value, NULL) : NULL;
  JSValueRef name = object && key ? JSObjectGetProperty(context, object, key, NULL) : NULL;
  JSStringRef actual = name && JSValueIsString(context, name) ? JSValueToStringCopy(context, name, NULL) : NULL;
  okay = key && expected && actual && JSStringIsEqual(actual, expected);
  if (actual) JSStringRelease(actual); if (key) JSStringRelease(key); if (expected) JSStringRelease(expected);
  if (json) JSStringRelease(json); if (context) JSGlobalContextRelease(context); free(bytes);
  int bin = openat(npm, "bin", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  okay = okay && bin >= 0 && !fstat(bin, &st) && cfg_readable(&st, actor, true) && cfg_source_acl(bin, true);
  int cli = okay ? openat(bin, "npm-cli.js", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC) : -1;
  okay = okay && cli >= 0 && !fstat(cli, &st) && S_ISREG(st.st_mode) && st.st_nlink == 1 && st.st_size > 0 &&
    cfg_readable(&st, actor, false) && cfg_source_acl(cli, false);
  if (cli >= 0 && close(cli)) okay = false;
  if (bin >= 0 && close(bin)) okay = false;
  return okay;
}
#endif
