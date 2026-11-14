#ifndef LEGIONCODE_HOST_ACCESS_H
#define LEGIONCODE_HOST_ACCESS_H
#include "legioncode-host-principal.h"
#include "legioncode-host-metadata.h"
#include <dirent.h>
#include <sys/acl.h>

/* First supported filesystem profile is deliberately narrow: actor-owned
 * ordinary files/directories with no existing extended ACL, setid or regular
 * hardlink aliases. Unsupported layouts fail BEFORE a command starts. */
#define LC_HOST_MAX_ACCESS_PINS 1024U
typedef struct { int fd; lc_host_file_identity identity; mode_t mode; bool ancestor; } lc_host_access_pin;
typedef struct {
  uid_t actor; gid_t actor_gid; lc_host_principal principal;
  const char *root_path; uint64_t root_device; CFArrayRef executables;
  int journal; size_t count; bool unknown;
  const lc_host_metadata *metadata; const lc_host_metadata_pins *metadata_pins;
  lc_host_access_pin pins[LC_HOST_MAX_ACCESS_PINS];
} lc_host_access;

/* dup/fcntl duplicates share the held directory's open-file-description offset.
 * Each traversal needs a NEW description, anchored to the original FD, so an
 * earlier scan cannot hide later-created entries or move another scan's cursor. */
static inline DIR *lc_host_directory_stream(int directory) {
  lc_host_file_identity held, independent;
  if (!lc_host_identity(directory, true, &held)) return NULL;
  int fd = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return NULL;
  if (!lc_host_identity(fd, true, &independent) || !lc_host_same(held, independent)) { close(fd); return NULL; }
  DIR *stream = fdopendir(fd);
  if (!stream) close(fd);
  return stream;
}

static inline bool lc_host_existing_symlink_safe(lc_host_access *access, int directory, const char *name) {
  char parent[PATH_MAX], path[PATH_MAX], target[PATH_MAX]; struct stat st;
  if (fcntl(directory, F_GETPATH, parent) || snprintf(path, sizeof(path), "%s/%s", parent, name) >= (int)sizeof(path) ||
      !realpath(path, target) || stat(target, &st) || !S_ISREG(st.st_mode) || (st.st_mode & (S_ISUID | S_ISGID))) return false;
  if (lc_host_metadata_contains(access->metadata, target, &st, access->metadata_pins)) return false;
  if (lc_host_beneath(access->root_path, target)) return true;
  /* Directory aliases outside the project and foreign setid execution aliases
   * are unsupported. A declared exact non-setid tool is the only external alias. */
  for (CFIndex i = 0; i < CFArrayGetCount(access->executables); i++) {
    char allowed[PATH_MAX];
    if (lc_host_text(CFArrayGetValueAtIndex(access->executables, i), allowed, sizeof(allowed)) && !strcmp(allowed, target)) return true;
  }
  return false;
}

static inline bool lc_host_acl_empty(int fd) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT;
  if (acl_valid(acl)) { acl_free(acl); return false; }
  acl_entry_t entry; errno = 0; int found = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  bool empty = found == -1 && errno == EINVAL; acl_free(acl); return empty;
}
static inline bool lc_host_acl_add(int fd, const lc_host_principal *principal, mode_t mode, bool directory, bool ancestor) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl && errno == ENOENT) acl = acl_init(1);
  acl_entry_t entry; acl_permset_t perms; acl_flagset_t flags;
  bool okay = acl && !acl_create_entry(&acl, &entry) && !acl_set_tag_type(entry, ACL_EXTENDED_ALLOW) &&
    !acl_set_qualifier(entry, principal->guid) && !acl_get_permset(entry, &perms) && !acl_clear_perms(perms);
  if (okay) {
    if (ancestor) okay = !acl_add_perm(perms, ACL_SEARCH);
    else {
      okay = !acl_add_perm(perms, ACL_READ_ATTRIBUTES) && !acl_add_perm(perms, ACL_READ_EXTATTRIBUTES) &&
        !acl_add_perm(perms, ACL_READ_SECURITY);
      if (okay && (mode & S_IRUSR)) okay = !acl_add_perm(perms, ACL_READ_DATA);
      if (okay && (mode & S_IXUSR)) okay = !acl_add_perm(perms, ACL_EXECUTE);
      if (okay && (mode & S_IWUSR)) okay = !acl_add_perm(perms, ACL_WRITE_DATA) && !acl_add_perm(perms, ACL_APPEND_DATA);
      if (okay && directory && (mode & S_IWUSR)) okay = !acl_add_perm(perms, ACL_DELETE_CHILD);
      if (okay && directory) {
        okay = !acl_get_flagset_np(entry, &flags) && !acl_clear_flags_np(flags) &&
          !acl_add_flag_np(flags, ACL_ENTRY_FILE_INHERIT) && !acl_add_flag_np(flags, ACL_ENTRY_DIRECTORY_INHERIT);
      }
    }
    if (okay) okay = !acl_set_fd_np(fd, acl, ACL_TYPE_EXTENDED);
  }
  if (acl) acl_free(acl); return okay;
}
static inline bool lc_host_ancestor_acl_safe(int fd) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT;
  bool okay = acl_valid(acl) == 0; acl_entry_t entry; int which = ACL_FIRST_ENTRY;
  while (okay && acl_get_entry(acl, which, &entry) == 0) {
    which = ACL_NEXT_ENTRY; acl_tag_t tag; acl_permset_t permissions;
    if (acl_get_tag_type(entry, &tag) || acl_get_permset(entry, &permissions) ||
        (tag == ACL_EXTENDED_DENY && acl_get_perm_np(permissions, ACL_SEARCH) != 0)) okay = false;
  }
  acl_free(acl); return okay;
}
static inline bool lc_host_acl_remove(int fd, const lc_host_principal *principal) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT;
  bool okay = acl_valid(acl) == 0; acl_entry_t entry; int which = ACL_FIRST_ENTRY, found = -1;
  errno = 0;
  while (okay && (found = acl_get_entry(acl, which, &entry)) == 0) {
    which = ACL_NEXT_ENTRY; void *qualifier = acl_get_qualifier(entry);
    if (!qualifier) { okay = false; break; }
    bool ours = !memcmp(qualifier, principal->guid, sizeof(uuid_t)); acl_free(qualifier);
    if (ours) {
      if (acl_delete_entry(acl, entry)) { okay = false; break; }
      which = ACL_FIRST_ENTRY;
    }
    errno = 0;
  }
  if (found != -1 || errno != EINVAL) okay = false;
  if (okay) okay = !acl_set_fd_np(fd, acl, ACL_TYPE_EXTENDED);
  acl_free(acl); return okay;
}
static inline bool lc_host_access_pin_node(lc_host_access *access, int fd, const char *relative, bool ancestor) {
  struct stat st; lc_host_file_identity identity;
  if (access->count >= LC_HOST_MAX_ACCESS_PINS || fstat(fd, &st) || st.st_uid != access->actor ||
      (!ancestor && (uint64_t)st.st_dev != access->root_device) ||
      (!S_ISDIR(st.st_mode) && !S_ISREG(st.st_mode)) || (st.st_mode & (S_ISUID | S_ISGID)) ||
      (S_ISREG(st.st_mode) && st.st_nlink != 1) || !(ancestor ? lc_host_ancestor_acl_safe(fd) : lc_host_acl_empty(fd)) ||
      !lc_host_identity(fd, S_ISDIR(st.st_mode), &identity)) return false;
  int held = fcntl(fd, F_DUPFD_CLOEXEC, 11); if (held < 0) return false;
  /* Append-before-change journal. Root keeps real descriptors through normal
   * cleanup; a broker crash leaves the physical writer obligation outstanding.
   * Recovery must validate/reconcile these identities, never replay the command. */
  struct { uint32_t version, flags, path_bytes, mode; lc_host_file_identity identity; } record;
  memset(&record, 0, sizeof(record)); record.version = 1; record.flags = ancestor ? 1 : 0;
  record.path_bytes = (uint32_t)strlen(relative); record.mode = (uint32_t)(st.st_mode & 07777); record.identity = identity;
  if (!record.path_bytes || record.path_bytes >= PATH_MAX ||
      !lc_host_io(access->journal, &record, sizeof(record), true) ||
      !lc_host_io(access->journal, (void *)relative, record.path_bytes, true) || !lc_host_sync(access->journal)) { close(held); return false; }
  access->pins[access->count++] = (lc_host_access_pin){ held, identity, st.st_mode & 07777, ancestor };
  return lc_host_acl_add(fd, &access->principal, st.st_mode, S_ISDIR(st.st_mode), ancestor);
}
static inline bool lc_host_access_walk(lc_host_access *access, int directory, const char *prefix, unsigned depth) {
  if (depth > 64) return false;
  DIR *entries = lc_host_directory_stream(directory); if (!entries) return false;
  bool okay = true; struct dirent *entry;
  while (okay) {
    errno = 0; entry = readdir(entries);
    if (!entry) { if (errno) okay = false; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    struct stat st; char path[PATH_MAX];
    if (fstatat(directory, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) ||
        snprintf(path, sizeof(path), "%s/%s", prefix, entry->d_name) >= (int)sizeof(path)) { okay = false; break; }
    char absolute[PATH_MAX];
    if (snprintf(absolute, sizeof(absolute), "%s/%s", access->root_path, path + 2) >= (int)sizeof(absolute)) { okay = false; break; }
    if (lc_host_metadata_contains(access->metadata, absolute, &st, access->metadata_pins)) continue;
    if (S_ISLNK(st.st_mode)) {
      if (st.st_uid != access->actor || !lc_host_existing_symlink_safe(access, directory, entry->d_name)) okay = false;
      continue;
    }
    if (!S_ISREG(st.st_mode) && !S_ISDIR(st.st_mode)) { okay = false; break; }
    int fd = openat(directory, entry->d_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (S_ISDIR(st.st_mode) ? O_DIRECTORY : 0));
    if (fd < 0) { okay = false; break; }
    okay = lc_host_access_pin_node(access, fd, path, false) &&
      (!S_ISDIR(st.st_mode) || lc_host_access_walk(access, fd, path, depth + 1));
    close(fd);
  }
  if (closedir(entries)) okay = false;
  return okay;
}
static inline bool lc_host_access_ancestors(lc_host_access *access, const char *root) {
  char copy[PATH_MAX]; strcpy(copy, root); char *slash = strrchr(copy, '/');
  if (!slash) return false; *slash = 0;
  while (copy[0]) {
    int fd = open(copy, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); struct stat st;
    if (fd < 0 || fstat(fd, &st)) { if (fd >= 0) close(fd); return false; }
    bool okay = true;
    /* World-searchable ancestors need no access mutation. An actor-private
     * ancestor receives search only, never listing or write authority. */
    if (!(st.st_mode & S_IXOTH)) okay = (st.st_mode & S_IXUSR) && lc_host_access_pin_node(access, fd, copy, true);
    close(fd); if (!okay) return false;
    slash = strrchr(copy, '/'); if (!slash) return false; *slash = 0;
  }
  return true;
}
static inline bool lc_host_access_prepare(lc_host_access *access, int root, const char *root_path) {
  return lc_host_access_ancestors(access, root_path) && lc_host_access_pin_node(access, root, ".", false) &&
    lc_host_access_walk(access, root, ".", 0);
}
static inline bool lc_host_restore_created(lc_host_access *access, int directory, unsigned depth, size_t *count) {
  if (depth > 64 || *count > LC_HOST_MAX_ENTRIES) return false;
  DIR *entries = lc_host_directory_stream(directory); if (!entries) return false;
  bool okay = true; struct dirent *entry;
  while (okay) {
    errno = 0; entry = readdir(entries);
    if (!entry) { if (errno) okay = false; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++*count > LC_HOST_MAX_ENTRIES) { okay = false; break; }
    struct stat st; if (fstatat(directory, entry->d_name, &st, AT_SYMLINK_NOFOLLOW)) { okay = false; break; }
    char parent[PATH_MAX], absolute[PATH_MAX];
    if (fcntl(directory, F_GETPATH, parent) || snprintf(absolute, sizeof(absolute), "%s/%s", parent, entry->d_name) >= (int)sizeof(absolute)) { okay = false; break; }
    if (lc_host_metadata_contains(access->metadata, absolute, &st, access->metadata_pins)) continue;
    if (S_ISLNK(st.st_mode)) {
      if (st.st_uid == access->principal.uid && fchownat(directory, entry->d_name, access->actor, access->actor_gid, AT_SYMLINK_NOFOLLOW)) okay = false;
      continue;
    }
    if ((!S_ISDIR(st.st_mode) && !S_ISREG(st.st_mode)) || (st.st_mode & (S_ISUID | S_ISGID))) { okay = false; break; }
    int fd = openat(directory, entry->d_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (S_ISDIR(st.st_mode) ? O_DIRECTORY : 0));
    if (fd < 0) { okay = false; break; }
    if (S_ISDIR(st.st_mode)) okay = lc_host_restore_created(access, fd, depth + 1, count);
    if (okay && st.st_uid == access->principal.uid)
      okay = lc_host_acl_remove(fd, &access->principal) && !fchown(fd, access->actor, access->actor_gid);
    close(fd);
  }
  if (closedir(entries)) okay = false; return okay;
}
static inline bool lc_host_access_restore(lc_host_access *access, int root) {
  bool okay = true; size_t count = 0;
  /* Call only with an irreversibly closed command creator gate and UID zero. */
  if (!lc_host_restore_created(access, root, 0, &count)) okay = false;
  for (size_t i = access->count; i > 0; i--) {
    lc_host_access_pin *pin = &access->pins[i - 1]; struct stat st; lc_host_file_identity actual;
    if (fstat(pin->fd, &st) || !lc_host_identity(pin->fd, S_ISDIR(st.st_mode), &actual) ||
        !lc_host_same(pin->identity, actual) || st.st_uid != access->actor ||
        (st.st_mode & 07777) != pin->mode || !lc_host_acl_remove(pin->fd, &access->principal)) okay = false;
  }
  if (!okay) { access->unknown = true; return false; }
  for (size_t i = 0; i < access->count; i++) if (close(access->pins[i].fd)) okay = false;
  if (okay) access->count = 0; else access->unknown = true;
  return okay;
}
#endif
