#ifndef LEGIONCODE_HOST_CONTRACT_H
#define LEGIONCODE_HOST_CONTRACT_H

/* Private native execution ABI. This is not an App Server or product protocol.
 * The broker has no provider credentials and produces no lifecycle events. */
#define _DARWIN_C_SOURCE 1
#include "legioncode-host-writer-contract.h"
#include "legioncode-host-setup-contract.h"
#include <CoreFoundation/CoreFoundation.h>
#include <CommonCrypto/CommonDigest.h>
#include <Security/Security.h>
#include <bsm/libbsm.h>
#include <dispatch/dispatch.h>
#include <xpc/xpc.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/acl.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <limits.h>
#include <membership.h>
#include <pwd.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define LC_HOST_SERVICE "dev.legioncode.desktop.native-host"
#define LC_HOST_APPROVAL "/Library/Application Support/LegionCode/NativeExecution/approval.plist"
#define LC_HOST_STATE LC_HOST_RESOURCE_STATE_DIRECTORY
#define LC_HOST_WORK "/private/var/legioncode-native-work"
#define LC_HOST_INSTALLED_BROKER "/Library/PrivilegedHelperTools/dev.legioncode.desktop.native-host"
#define LC_HOST_ABI 1U
#define LC_HOST_MAX_FIELDS 32U
#define LC_HOST_MAX_FRAME (128U * 1024U)
#define LC_HOST_MAX_SCOPES 4U
#define LC_HOST_MAX_PRINCIPALS 64U
#define LC_HOST_MAX_OUTPUT (128U * 1024U)
#define LC_HOST_MAX_ENTRIES 20000U

static inline bool lc_host_writer_supported(void) {
  return &lc_writer_host_resource_prepare != NULL && &lc_writer_host_resource_assert != NULL &&
         &lc_writer_host_resource_complete != NULL;
}
static inline bool lc_host_identity(int fd, bool directory, lc_host_file_identity *out) {
  struct stat st;
  if (fstat(fd, &st) || (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode))) return false;
  out->device = (uint64_t)st.st_dev; out->inode = (uint64_t)st.st_ino; return true;
}
static inline bool lc_host_same(lc_host_file_identity a, lc_host_file_identity b) {
  return a.device == b.device && a.inode == b.inode;
}
static inline bool lc_host_sync(int fd) {
  int result; do { result = fsync(fd); } while (result && errno == EINTR); return result == 0;
}
static inline bool lc_host_io(int fd, void *buffer, size_t size, bool writing) {
  unsigned char *cursor = buffer;
  while (size) {
    ssize_t n = writing ? write(fd, cursor, size) : read(fd, cursor, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    cursor += n; size -= (size_t)n;
  }
  return true;
}
static inline bool lc_host_hex(const unsigned char *bytes, size_t size, char *out, size_t bound) {
  static const char digits[] = "0123456789abcdef";
  if (bound < size * 2 + 1) return false;
  for (size_t i = 0; i < size; i++) { out[i * 2] = digits[bytes[i] >> 4]; out[i * 2 + 1] = digits[bytes[i] & 15]; }
  out[size * 2] = 0; return true;
}
static inline bool lc_host_unhex(const char *value, unsigned char *out, size_t size) {
  if (!value || strlen(value) != size * 2) return false;
  for (size_t i = 0; i < size; i++) {
    unsigned int n = 0;
    for (size_t j = 0; j < 2; j++) {
      char c = value[i * 2 + j];
      if (c >= '0' && c <= '9') n = n * 16 + (unsigned)(c - '0');
      else if (c >= 'a' && c <= 'f') n = n * 16 + (unsigned)(c - 'a' + 10);
      else return false;
    }
    out[i] = (unsigned char)n;
  }
  return true;
}
static inline bool lc_host_text(CFTypeRef value, char *out, size_t bound) {
  return value && CFGetTypeID(value) == CFStringGetTypeID() &&
    CFStringGetCString(value, out, (CFIndex)bound, kCFStringEncodingUTF8);
}
static inline bool lc_host_number(CFTypeRef value, uint32_t *out) {
  int64_t n;
  if (!value || CFGetTypeID(value) != CFNumberGetTypeID() ||
      !CFNumberGetValue(value, kCFNumberSInt64Type, &n) || n < 0 || n > UINT32_MAX) return false;
  *out = (uint32_t)n; return true;
}
static inline bool lc_host_absolute(const char *value) {
  if (!value || value[0] != '/' || value[1] == 0 || strlen(value) >= PATH_MAX ||
      strchr(value, '\n') || strchr(value, '\r') || strstr(value, "/../") || strstr(value, "/./")) return false;
  char resolved[PATH_MAX]; return realpath(value, resolved) && !strcmp(value, resolved);
}
static inline bool lc_host_beneath(const char *parent, const char *path) {
  size_t n = strlen(parent); return !strncmp(parent, path, n) && (path[n] == '/' || path[n] == 0);
}
static inline bool lc_host_monotonic(uint64_t *out) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < 0) return false;
  *out = (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000; return true;
}
/* A POSIX 0700/0600 mode does not exclude macOS ACL grants. Conservatively
 * reject every potential mutating allow ACE except one resolved to root UID.
 * Deny-only and read/search-only ACEs do not grant mutation and need no rewrite;
 * inherit-only mutation grants are also rejected for protected ancestors. */
static inline bool lc_host_protected_acl(int fd) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT;
  if (acl_valid(acl)) { acl_free(acl); return false; }
  bool okay = true; int which = ACL_FIRST_ENTRY;
  const acl_perm_t mutations[] = { ACL_WRITE_DATA, ACL_APPEND_DATA, ACL_DELETE, ACL_DELETE_CHILD,
    ACL_WRITE_ATTRIBUTES, ACL_WRITE_EXTATTRIBUTES, ACL_WRITE_SECURITY, ACL_CHANGE_OWNER };
  for (;;) {
    acl_entry_t entry; errno = 0;
    if (acl_get_entry(acl, which, &entry)) { if (errno != EINVAL) okay = false; break; }
    which = ACL_NEXT_ENTRY; acl_tag_t tag;
    if (acl_get_tag_type(entry, &tag)) { okay = false; break; }
    if (tag == ACL_EXTENDED_DENY) continue;
    if (tag != ACL_EXTENDED_ALLOW) { okay = false; break; }
    acl_permset_t permissions; if (acl_get_permset(entry, &permissions)) { okay = false; break; }
    bool mutating = false;
    for (size_t i = 0; i < sizeof(mutations) / sizeof(mutations[0]); i++) {
      int granted = acl_get_perm_np(permissions, mutations[i]);
      if (granted < 0) { okay = false; break; }
      if (granted) mutating = true;
    }
    if (!okay) break;
    if (!mutating) continue;
    void *qualifier = acl_get_qualifier(entry); id_t id = (id_t)-1; int type = -1;
    bool root_only = qualifier && !mbr_uuid_to_id(qualifier, &id, &type) && type == ID_TYPE_UID && id == 0;
    if (qualifier) acl_free(qualifier);
    if (!root_only) { okay = false; break; }
  }
  acl_free(acl); return okay;
}
static inline bool lc_host_protected_fd(int fd, bool directory) {
  struct stat st;
  return !fstat(fd, &st) && st.st_uid == 0 && !(st.st_mode & 0022) &&
    (directory ? S_ISDIR(st.st_mode) : S_ISREG(st.st_mode)) && lc_host_protected_acl(fd);
}
/* No path creation, chmod or ACL repair: every component must already have
 * protected authority, including / and the final file/directory. */
static inline int lc_host_open_protected(const char *path, bool directory) {
  char copy[PATH_MAX];
  if (!path || path[0] != '/' || strlen(path) >= sizeof(copy)) return -1;
  strcpy(copy, path); int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) return -1;
  if (!lc_host_protected_fd(current, true)) { close(current); return -1; }
  char *save = NULL, *part = strtok_r(copy + 1, "/", &save);
  while (part) {
    char *next = strtok_r(NULL, "/", &save);
    if (!strcmp(part, ".") || !strcmp(part, "..")) { close(current); return -1; }
    int fd = openat(current, part, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | ((next || directory) ? O_DIRECTORY : 0));
    close(current); current = fd;
    if (fd < 0 || !lc_host_protected_fd(fd, next || directory)) {
      if (fd >= 0) close(fd); return -1;
    }
    part = next;
  }
  return current;
}
#endif
