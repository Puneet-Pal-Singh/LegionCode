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
#define LC_HOST_ACCESS_ACL_BYTES (16U * 1024U)
#define LC_HOST_ACCESS_JOURNAL_BYTES (64U * 1024U * 1024U)
#define LC_HOST_ACCESS_FRAME_MAGIC 0x4c43414aU
#define LC_HOST_ACCESS_PIN 1U
#define LC_HOST_ACCESS_CLOSED 2U
/* Private Mac journal ABI, not a product log or permission/recovery issuer.
 * Native padding is zeroed and hashed; header_bytes rejects another layout. */
typedef struct {
  uint32_t magic, version, kind, header_bytes, frame_bytes, path_bytes, acl_bytes, flags;
  uint64_t sequence, command_ordinal, pin_ordinal;
  lc_host_writer_binding binding;
  char boot[40], generation[65];
  uint32_t actor_gid, principal_gid, uid, gid, mode, type;
  uint64_t device, inode;
  int64_t birth_seconds;
  uint32_t birth_nanoseconds, reserved;
  unsigned char command_id[32], command_sha256[32], previous[32];
} lc_host_access_frame;
typedef struct {
  int fd; bool close_attempted;
  lc_host_access_frame frame;
  unsigned char digest[32], path_sha256[32];
  acl_t baseline;
  unsigned char *baseline_bytes, *granted_bytes;
  size_t granted_size;
} lc_host_access_pin;
typedef enum { LC_HOST_ACCESS_INVALID = -1, LC_HOST_ACCESS_PENDING, LC_HOST_ACCESS_VALID } lc_host_access_validation;
typedef struct {
  uid_t actor; gid_t actor_gid; lc_host_principal principal;
  const char *root_path; uint64_t root_device; CFArrayRef executables;
  int journal; size_t count; bool unknown, journal_bound, validating, validated, cleanup_started;
  const lc_host_writer_binding *binding;
  const char *boot, *generation;
  const unsigned char (*command_ids)[32];
  uint64_t command_ordinal, closed_command_ordinal, journal_bytes, journal_frames;
  unsigned char command_sha256[32], tail[32];
  struct stat journal_identity, validation_identity;
  uint64_t validation_offset, validation_sequence, validation_command, validation_pins;
  bool validation_closed;
  unsigned char validation_previous[32], validation_command_sha256[32];
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

static inline bool lc_host_acl_empty(acl_t acl) {
  if (!acl || acl_valid(acl)) return false;
  acl_entry_t entry; errno = 0; int found = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  return found == -1 && errno == EINVAL;
}
static inline bool lc_host_acl_add_entry(acl_t *acl, const lc_host_principal *principal, mode_t mode, bool directory, bool ancestor) {
  acl_entry_t entry; acl_permset_t perms; acl_flagset_t flags;
  bool okay = acl && *acl && !acl_create_entry(acl, &entry) && !acl_set_tag_type(entry, ACL_EXTENDED_ALLOW) &&
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
  }
  return okay;
}
static inline bool lc_host_ancestor_acl_safe(acl_t acl) {
  if (!acl || acl_valid(acl)) return false;
  acl_entry_t entry; int which = ACL_FIRST_ENTRY, found; size_t count = 0; errno = 0;
  while ((found = acl_get_entry(acl, which, &entry)) == 0) {
    if (++count > ACL_MAX_ENTRIES) return false;
    which = ACL_NEXT_ENTRY; acl_tag_t tag; acl_permset_t permissions;
    if (acl_get_tag_type(entry, &tag) || acl_get_permset(entry, &permissions) ||
        (tag == ACL_EXTENDED_DENY && acl_get_perm_np(permissions, ACL_SEARCH) != 0)) return false;
    errno = 0;
  }
  return found == -1 && errno == EINVAL;
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
/* External ACL bytes are produced only from valid ORIGINAL library objects.
 * Never deserialize a lengthless acl_copy_int() from journal input. An absent
 * ACL is represented by the library's exact empty ACL, preserving its semantics. */
static inline acl_t lc_host_access_acl(int fd) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl && errno == ENOENT) acl = acl_init(0);
  if (acl && acl_valid(acl)) { acl_free(acl); return NULL; }
  return acl;
}
static inline bool lc_host_access_acl_bytes(acl_t acl, unsigned char **out, size_t *size) {
  ssize_t bytes = acl_size(acl);
  if (bytes <= 0 || bytes > LC_HOST_ACCESS_ACL_BYTES) return false;
  unsigned char *copy = calloc(1, (size_t)bytes); if (!copy) return false;
  if (acl_copy_ext(copy, acl, bytes) != bytes) { free(copy); return false; }
  *out = copy; *size = (size_t)bytes; return true;
}
static inline bool lc_host_access_acl_matches(acl_t acl, const unsigned char *expected, size_t size) {
  unsigned char bytes[LC_HOST_ACCESS_ACL_BYTES];
  return size > 0 && size <= sizeof(bytes) && acl_size(acl) == (ssize_t)size &&
    acl_copy_ext(bytes, acl, (ssize_t)size) == (ssize_t)size && !memcmp(bytes, expected, size);
}
static inline bool lc_host_access_io(int fd, void *buffer, size_t size, uint64_t offset, bool writing) {
  if (offset > LC_HOST_ACCESS_JOURNAL_BYTES || size > LC_HOST_ACCESS_JOURNAL_BYTES - offset) return false;
  unsigned char *cursor = buffer;
  while (size) {
    ssize_t bytes = writing ? pwrite(fd, cursor, size, (off_t)offset) : pread(fd, cursor, size, (off_t)offset);
    if (bytes < 0 && errno == EINTR) continue;
    if (bytes <= 0) return false;
    cursor += bytes; offset += (uint64_t)bytes; size -= (size_t)bytes;
  }
  return true;
}
static inline bool lc_host_access_same_journal(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_uid == b->st_uid && a->st_gid == b->st_gid &&
    a->st_birthtimespec.tv_sec == b->st_birthtimespec.tv_sec && a->st_birthtimespec.tv_nsec == b->st_birthtimespec.tv_nsec;
}
static inline bool lc_host_access_journal_current(lc_host_access *access, struct stat *st) {
  int flags = fcntl(access->journal, F_GETFL);
  return flags >= 0 && (flags & O_ACCMODE) == O_RDWR && !(flags & O_APPEND) &&
    !fstat(access->journal, st) && S_ISREG(st->st_mode) && st->st_uid == 0 && st->st_nlink == 1 &&
    (st->st_mode & 07777) == 0600 && lc_host_protected_fd(access->journal, false) &&
    st->st_size >= 0 && (uint64_t)st->st_size == access->journal_bytes &&
    lc_host_access_same_journal(st, &access->journal_identity);
}
static inline void lc_host_access_frame_begin(lc_host_access *access, lc_host_access_frame *frame, uint32_t kind) {
  memset(frame, 0, sizeof(*frame)); frame->magic = LC_HOST_ACCESS_FRAME_MAGIC; frame->version = 2;
  frame->kind = kind; frame->header_bytes = sizeof(*frame); frame->sequence = access->journal_frames + 1;
  frame->command_ordinal = access->command_ordinal; frame->binding = *access->binding;
  memcpy(frame->boot, access->boot, sizeof(frame->boot)); memcpy(frame->generation, access->generation, sizeof(frame->generation));
  frame->actor_gid = access->actor_gid; frame->principal_gid = access->principal.gid;
  memcpy(frame->command_id, access->command_ids[access->command_ordinal - 1], 32);
  memcpy(frame->command_sha256, access->command_sha256, 32); memcpy(frame->previous, access->tail, 32);
}
static inline bool lc_host_access_append(lc_host_access *access, lc_host_access_frame *frame,
    const char *path, const unsigned char *acl, unsigned char digest[32]) {
  uint64_t bytes = sizeof(*frame) + (uint64_t)frame->path_bytes + frame->acl_bytes + 32;
  struct stat st;
  if (bytes > UINT32_MAX || access->journal_bytes > LC_HOST_ACCESS_JOURNAL_BYTES ||
      bytes > LC_HOST_ACCESS_JOURNAL_BYTES - access->journal_bytes ||
      !lc_host_access_journal_current(access, &st)) { access->unknown = true; return false; }
  frame->frame_bytes = (uint32_t)bytes;
  CC_SHA256_CTX hash; CC_SHA256_Init(&hash); CC_SHA256_Update(&hash, frame, sizeof(*frame));
  if (frame->path_bytes) CC_SHA256_Update(&hash, path, frame->path_bytes);
  if (frame->acl_bytes) CC_SHA256_Update(&hash, acl, frame->acl_bytes);
  CC_SHA256_Final(digest, &hash);
  uint64_t offset = access->journal_bytes;
  bool okay = lc_host_access_io(access->journal, frame, sizeof(*frame), offset, true);
  offset += sizeof(*frame);
  if (okay && frame->path_bytes) okay = lc_host_access_io(access->journal, (void *)path, frame->path_bytes, offset, true);
  offset += frame->path_bytes;
  if (okay && frame->acl_bytes) okay = lc_host_access_io(access->journal, (void *)acl, frame->acl_bytes, offset, true);
  offset += frame->acl_bytes;
  if (!okay || !lc_host_access_io(access->journal, digest, 32, offset, true) || !lc_host_sync(access->journal)) {
    access->unknown = true; return false;
  }
  access->journal_bytes += bytes; access->journal_frames++;
  memcpy(access->tail, digest, 32); return true;
}
static inline bool lc_host_access_pin_identity(const lc_host_access_pin *pin) {
  struct stat st;
  return pin->fd >= 0 && !pin->close_attempted && !fstat(pin->fd, &st) &&
    (uint64_t)st.st_dev == pin->frame.device && (uint64_t)st.st_ino == pin->frame.inode &&
    st.st_birthtimespec.tv_sec == pin->frame.birth_seconds && (int64_t)st.st_birthtimespec.tv_nsec == (int64_t)pin->frame.birth_nanoseconds &&
    st.st_uid == pin->frame.uid && st.st_gid == pin->frame.gid && (uint32_t)(st.st_mode & 07777) == pin->frame.mode &&
    (uint32_t)(st.st_mode & S_IFMT) == pin->frame.type && (S_ISDIR(st.st_mode) || st.st_nlink <= 1);
}
static inline bool lc_host_access_pin_acl(const lc_host_access_pin *pin) {
  acl_t current = lc_host_access_acl(pin->fd); if (!current) return false;
  bool okay = lc_host_access_acl_matches(current, pin->baseline_bytes, pin->frame.acl_bytes) ||
    lc_host_access_acl_matches(current, pin->granted_bytes, pin->granted_size);
  acl_free(current); return okay;
}
static inline bool lc_host_access_pin_node(lc_host_access *access, int fd, const char *relative, bool ancestor) {
  struct stat st; lc_host_file_identity identity;
  if (access->count >= LC_HOST_MAX_ACCESS_PINS || fstat(fd, &st) || st.st_uid != access->actor ||
      (!ancestor && (uint64_t)st.st_dev != access->root_device) || (st.st_birthtimespec.tv_sec < 0) ||
      st.st_birthtimespec.tv_nsec < 0 || st.st_birthtimespec.tv_nsec >= 1000000000 ||
      (!S_ISDIR(st.st_mode) && !S_ISREG(st.st_mode)) || (st.st_mode & (S_ISUID | S_ISGID)) ||
      (S_ISREG(st.st_mode) && st.st_nlink != 1) ||
      !lc_host_identity(fd, S_ISDIR(st.st_mode), &identity)) return false;
  lc_host_access_pin candidate; memset(&candidate, 0, sizeof(candidate)); candidate.fd = -1;
  candidate.baseline = lc_host_access_acl(fd); acl_t granted = candidate.baseline ? acl_dup(candidate.baseline) : NULL;
  size_t baseline_size = 0;
  bool okay = granted && (ancestor ? lc_host_ancestor_acl_safe(candidate.baseline) : lc_host_acl_empty(candidate.baseline)) &&
    lc_host_acl_add_entry(&granted, &access->principal, st.st_mode, S_ISDIR(st.st_mode), ancestor) &&
    lc_host_access_acl_bytes(candidate.baseline, &candidate.baseline_bytes, &baseline_size) &&
    lc_host_access_acl_bytes(granted, &candidate.granted_bytes, &candidate.granted_size);
  if (!okay) {
    if (candidate.baseline) acl_free(candidate.baseline); if (granted) acl_free(granted);
    free(candidate.baseline_bytes); free(candidate.granted_bytes); return false;
  }
  /* Reject a resource-budget overflow before this node changes, retaining room
   * for the current epoch's positive-close footer after all committed pins. */
  size_t path_bytes = strlen(relative);
  uint64_t needed = sizeof(lc_host_access_frame) * 2U + path_bytes + baseline_size + 64U;
  if (!path_bytes || path_bytes >= PATH_MAX || access->journal_bytes > LC_HOST_ACCESS_JOURNAL_BYTES ||
      needed > LC_HOST_ACCESS_JOURNAL_BYTES - access->journal_bytes) {
    acl_free(candidate.baseline); acl_free(granted); free(candidate.baseline_bytes); free(candidate.granted_bytes); return false;
  }
  candidate.fd = fcntl(fd, F_DUPFD_CLOEXEC, 11);
  if (candidate.fd < 0) { acl_free(candidate.baseline); acl_free(granted); free(candidate.baseline_bytes); free(candidate.granted_bytes); return false; }
  lc_host_access_frame_begin(access, &candidate.frame, LC_HOST_ACCESS_PIN);
  candidate.frame.path_bytes = (uint32_t)path_bytes; candidate.frame.acl_bytes = (uint32_t)baseline_size;
  candidate.frame.pin_ordinal = access->count + 1; candidate.frame.flags = ancestor ? 1 : 0;
  candidate.frame.device = identity.device; candidate.frame.inode = identity.inode;
  candidate.frame.uid = st.st_uid; candidate.frame.gid = st.st_gid; candidate.frame.mode = st.st_mode & 07777;
  candidate.frame.type = st.st_mode & S_IFMT; candidate.frame.birth_seconds = st.st_birthtimespec.tv_sec;
  candidate.frame.birth_nanoseconds = (uint32_t)st.st_birthtimespec.tv_nsec;
  CC_SHA256(relative, (CC_LONG)strlen(relative), candidate.path_sha256);
  /* Retain the original pin even on a partial/uncertain append. No ACE changes
   * before the complete frame and fsync; no retry closes an uncertain fd number. */
  lc_host_access_pin *pin = &access->pins[access->count++]; *pin = candidate;
  okay = candidate.frame.path_bytes && candidate.frame.path_bytes < PATH_MAX &&
    lc_host_access_append(access, &pin->frame, relative, pin->baseline_bytes, pin->digest);
  if (okay) {
    acl_t current = lc_host_access_acl(fd);
    okay = current && lc_host_access_acl_matches(current, pin->baseline_bytes, pin->frame.acl_bytes) && lc_host_access_pin_identity(pin);
    if (current) acl_free(current);
    if (okay) okay = !acl_set_fd_np(fd, granted, ACL_TYPE_EXTENDED);
  }
  acl_free(granted); return okay;
}
static inline bool lc_host_access_walk(lc_host_access *access, int directory, const char *prefix, unsigned depth) {
  if (depth > 64) return false;
  DIR *entries = lc_host_directory_stream(directory); if (!entries) { access->unknown = true; return false; }
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
    if (close(fd)) { access->unknown = true; okay = false; }
  }
  if (closedir(entries)) { access->unknown = true; okay = false; }
  return okay;
}
static inline bool lc_host_access_ancestors(lc_host_access *access, const char *root) {
  char copy[PATH_MAX]; strcpy(copy, root); char *slash = strrchr(copy, '/');
  if (!slash) return false; *slash = 0;
  while (copy[0]) {
    int fd = open(copy, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); struct stat st;
    if (fd < 0 || fstat(fd, &st)) {
      if (fd >= 0 && close(fd)) access->unknown = true;
      return false;
    }
    bool okay = true;
    /* World-searchable ancestors need no access mutation. An actor-private
     * ancestor receives search only, never listing or write authority. */
    if (!(st.st_mode & S_IXOTH)) okay = (st.st_mode & S_IXUSR) && lc_host_access_pin_node(access, fd, copy, true);
    if (close(fd)) { access->unknown = true; okay = false; }
    if (!okay) return false;
    slash = strrchr(copy, '/'); if (!slash) return false; *slash = 0;
  }
  return true;
}
static inline bool lc_host_access_begin(lc_host_access *access, uint64_t command_ordinal, const unsigned char command_sha256[32]) {
  if (access->unknown || access->count || !access->binding || !access->boot || !access->generation || !access->command_ids ||
      command_ordinal <= access->command_ordinal || command_ordinal > 256 ||
      access->binding->actor_uid != access->actor || access->binding->execution_uid != access->principal.uid ||
      memcmp(access->binding->principal_guid, access->principal.guid, 16)) return false;
  if (!access->journal_bound) {
    if (fstat(access->journal, &access->journal_identity) || access->journal_identity.st_size != 0) { access->unknown = true; return false; }
    access->journal_bound = true;
  }
  struct stat st;
  if (!lc_host_access_journal_current(access, &st)) { access->unknown = true; return false; }
  access->command_ordinal = command_ordinal; memcpy(access->command_sha256, command_sha256, 32);
  access->validating = access->validated = access->cleanup_started = false; return true;
}
static inline bool lc_host_access_prepare(lc_host_access *access, int root, const char *root_path,
    uint64_t command_ordinal, const unsigned char command_sha256[32]) {
  return lc_host_access_begin(access, command_ordinal, command_sha256) && lc_host_access_ancestors(access, root_path) &&
    lc_host_access_pin_node(access, root, ".", false) && lc_host_access_walk(access, root, ".", 0);
}
static inline bool lc_host_access_journal_unchanged(lc_host_access *access) {
  struct stat st;
  return lc_host_access_journal_current(access, &st) &&
    st.st_mtimespec.tv_sec == access->validation_identity.st_mtimespec.tv_sec &&
    st.st_mtimespec.tv_nsec == access->validation_identity.st_mtimespec.tv_nsec &&
    st.st_ctimespec.tv_sec == access->validation_identity.st_ctimespec.tv_sec &&
    st.st_ctimespec.tv_nsec == access->validation_identity.st_ctimespec.tv_nsec;
}
static inline bool lc_host_access_validate_frame(lc_host_access *access) {
  lc_host_access_frame frame; unsigned char payload[PATH_MAX + LC_HOST_ACCESS_ACL_BYTES + 32], digest[32];
  uint64_t remaining = access->journal_bytes - access->validation_offset;
  if (remaining < sizeof(frame) + 32 || !lc_host_access_io(access->journal, &frame, sizeof(frame), access->validation_offset, false)) return false;
  uint64_t bytes = sizeof(frame) + (uint64_t)frame.path_bytes + frame.acl_bytes + 32;
  if (frame.magic != LC_HOST_ACCESS_FRAME_MAGIC || frame.version != 2 || frame.header_bytes != sizeof(frame) ||
      frame.frame_bytes != bytes || bytes > remaining || frame.path_bytes >= PATH_MAX || frame.acl_bytes > LC_HOST_ACCESS_ACL_BYTES ||
      frame.reserved || frame.sequence != access->validation_sequence + 1 ||
      memcmp(&frame.binding, access->binding, sizeof(frame.binding)) || memcmp(frame.boot, access->boot, sizeof(frame.boot)) ||
      memcmp(frame.generation, access->generation, sizeof(frame.generation)) || frame.actor_gid != access->actor_gid ||
      frame.principal_gid != access->principal.gid || !frame.command_ordinal || frame.command_ordinal > access->command_ordinal ||
      memcmp(frame.command_id, access->command_ids[frame.command_ordinal - 1], 32) || !lc_host_nonzero(frame.command_sha256, 32) ||
      memcmp(frame.previous, access->validation_previous, 32)) return false;
  size_t payload_bytes = (size_t)frame.path_bytes + frame.acl_bytes;
  if (!lc_host_access_io(access->journal, payload, payload_bytes + 32, access->validation_offset + sizeof(frame), false)) return false;
  CC_SHA256_CTX hash; CC_SHA256_Init(&hash); CC_SHA256_Update(&hash, &frame, sizeof(frame));
  if (payload_bytes) CC_SHA256_Update(&hash, payload, (CC_LONG)payload_bytes);
  CC_SHA256_Final(digest, &hash);
  if (memcmp(digest, payload + payload_bytes, 32)) return false;
  if (frame.kind == LC_HOST_ACCESS_PIN) {
    if (!frame.path_bytes || !frame.acl_bytes || memchr(payload, 0, frame.path_bytes) || frame.flags > 1 ||
        (frame.type != S_IFREG && frame.type != S_IFDIR) || frame.uid != access->actor ||
        (frame.mode & ~07777U) || (frame.mode & (S_ISUID | S_ISGID)) || !frame.inode ||
        frame.birth_seconds < 0 || frame.birth_nanoseconds >= 1000000000) return false;
    if (access->validation_closed) {
      if (frame.command_ordinal <= access->validation_command) return false;
      access->validation_command = frame.command_ordinal; access->validation_pins = 0; access->validation_closed = false;
      memcpy(access->validation_command_sha256, frame.command_sha256, 32);
    }
    if (frame.command_ordinal != access->validation_command || frame.pin_ordinal != ++access->validation_pins ||
        access->validation_pins > LC_HOST_MAX_ACCESS_PINS || memcmp(frame.command_sha256, access->validation_command_sha256, 32)) return false;
    if (frame.command_ordinal == access->command_ordinal && memcmp(frame.command_sha256, access->command_sha256, 32)) return false;
    /* Closed epochs retain their complete frame/footer proof, not live pins.
     * Original-pin comparison applies only while this epoch still owns pins. */
    if (access->count && frame.command_ordinal == access->command_ordinal) {
      if (frame.pin_ordinal > access->count) return false;
      const lc_host_access_pin *pin = &access->pins[frame.pin_ordinal - 1]; unsigned char path_sha256[32];
      CC_SHA256(payload, frame.path_bytes, path_sha256);
      if (memcmp(&frame, &pin->frame, sizeof(frame)) || memcmp(digest, pin->digest, 32) ||
          memcmp(path_sha256, pin->path_sha256, 32) || memcmp(payload + frame.path_bytes, pin->baseline_bytes, frame.acl_bytes) ||
          !lc_host_access_pin_identity(pin) || !lc_host_access_pin_acl(pin)) return false;
    }
  } else if (frame.kind == LC_HOST_ACCESS_CLOSED) {
    if (access->validation_closed || frame.command_ordinal != access->validation_command || (access->count && frame.command_ordinal >= access->command_ordinal) ||
        frame.pin_ordinal != access->validation_pins || frame.path_bytes || frame.acl_bytes || frame.flags || frame.uid || frame.gid ||
        frame.mode || frame.type || frame.device || frame.inode || frame.birth_seconds || frame.birth_nanoseconds ||
        memcmp(frame.command_sha256, access->validation_command_sha256, 32)) return false;
    access->validation_closed = true; access->validation_pins = 0;
  } else return false;
  access->validation_sequence = frame.sequence; access->validation_offset += bytes;
  memcpy(access->validation_previous, digest, 32); return true;
}
/* Bounded original-FD preflight yields to Stop/other scopes. NOT a recovery
 * reader: every current PIN must match its ORIGINAL live fd and captured ACL. */
static inline lc_host_access_validation lc_host_access_validate(lc_host_access *access) {
  if (access->unknown) return LC_HOST_ACCESS_INVALID;
  if (access->validated) {
    if (lc_host_access_journal_unchanged(access)) return LC_HOST_ACCESS_VALID;
    goto invalid;
  }
  if (!access->validating) {
    if (!access->journal_bound) {
      if (fstat(access->journal, &access->journal_identity) || access->journal_identity.st_size != 0) goto invalid;
      access->journal_bound = true;
    }
    if (!lc_host_access_journal_current(access, &access->validation_identity)) goto invalid;
    access->cleanup_started = true;
    access->validation_offset = access->validation_sequence = access->validation_command = access->validation_pins = 0;
    access->validation_closed = true; memset(access->validation_previous, 0, 32); access->validating = true;
  }
  uint64_t start, now; if (!lc_host_monotonic(&start)) goto invalid;
  for (size_t i = 0; i < 64 && access->validation_offset < access->journal_bytes; i++) {
    if (!lc_host_monotonic(&now)) goto invalid;
    if (now - start >= 2) return LC_HOST_ACCESS_PENDING;
    if (!lc_host_access_validate_frame(access)) goto invalid;
  }
  if (access->validation_offset < access->journal_bytes) return LC_HOST_ACCESS_PENDING;
  if (access->validation_sequence != access->journal_frames ||
      (access->count ? access->validation_closed || access->validation_command != access->command_ordinal || access->validation_pins != access->count :
        !access->validation_closed || access->validation_command != access->closed_command_ordinal || access->validation_pins) ||
      memcmp(access->validation_previous, access->tail, 32) || !lc_host_access_journal_unchanged(access)) goto invalid;
  access->validating = false; access->validated = true; return LC_HOST_ACCESS_VALID;
invalid:
  access->unknown = true; return LC_HOST_ACCESS_INVALID;
}
static inline bool lc_host_restore_created(lc_host_access *access, int directory, unsigned depth, size_t *count) {
  if (depth > 64 || *count > LC_HOST_MAX_ENTRIES) return false;
  DIR *entries = lc_host_directory_stream(directory); if (!entries) { access->unknown = true; return false; }
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
    if (close(fd)) { access->unknown = true; okay = false; }
  }
  if (closedir(entries)) { access->unknown = true; okay = false; } return okay;
}
static inline bool lc_host_access_restore(lc_host_access *access, int root) {
  /* Whole journal AND every original pin passed preflight before ANY restore. */
  if (access->unknown || !access->validated || !lc_host_access_journal_unchanged(access)) { access->unknown = true; return false; }
  bool okay = true; size_t count = 0;
  /* Call only with an irreversibly closed command creator gate and UID zero. */
  if (!lc_host_restore_created(access, root, 0, &count)) okay = false;
  for (size_t i = access->count; i > 0; i--) {
    lc_host_access_pin *pin = &access->pins[i - 1];
    if (!lc_host_access_pin_identity(pin)) { okay = false; break; }
    acl_t current = lc_host_access_acl(pin->fd);
    bool baseline = current && lc_host_access_acl_matches(current, pin->baseline_bytes, pin->frame.acl_bytes);
    bool granted = current && lc_host_access_acl_matches(current, pin->granted_bytes, pin->granted_size);
    if (current) acl_free(current);
    if ((!baseline && !granted) || !lc_host_access_pin_identity(pin) ||
        (!baseline && acl_set_fd_np(pin->fd, pin->baseline, ACL_TYPE_EXTENDED))) { okay = false; break; }
    acl_t restored = lc_host_access_acl(pin->fd);
    bool matches = restored && lc_host_access_acl_matches(restored, pin->baseline_bytes, pin->frame.acl_bytes) && lc_host_access_pin_identity(pin);
    if (restored) acl_free(restored);
    if (!matches) { okay = false; break; }
  }
  if (!okay) { access->unknown = true; return false; }
  for (size_t i = 0; i < access->count; i++) {
    lc_host_access_pin *pin = &access->pins[i]; int original = pin->fd;
    pin->fd = -1; pin->close_attempted = true;
    if (original < 0 || close(original)) okay = false;
  }
  if (!okay) { access->unknown = true; return false; }
  lc_host_access_frame closed; unsigned char digest[32];
  lc_host_access_frame_begin(access, &closed, LC_HOST_ACCESS_CLOSED); closed.pin_ordinal = access->count;
  if (!lc_host_access_append(access, &closed, NULL, NULL, digest)) return false;
  for (size_t i = 0; i < access->count; i++) {
    acl_free(access->pins[i].baseline); free(access->pins[i].baseline_bytes); free(access->pins[i].granted_bytes);
    memset(&access->pins[i], 0, sizeof(access->pins[i])); access->pins[i].fd = -1;
  }
  access->closed_command_ordinal = access->command_ordinal;
  access->count = 0; access->validated = access->validating = false; return true;
}
#endif
