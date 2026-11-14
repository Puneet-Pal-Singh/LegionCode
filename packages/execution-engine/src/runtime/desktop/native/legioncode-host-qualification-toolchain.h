#ifndef LEGIONCODE_HOST_QUALIFICATION_TOOLCHAIN_H
#define LEGIONCODE_HOST_QUALIFICATION_TOOLCHAIN_H
#include "legioncode-host-approval.h"

typedef struct {
  char node[PATH_MAX], npm[PATH_MAX], node_sha[65], npm_sha[65], bash_sha[65], node_cdhash[129];
  int fd[3]; lc_host_file_identity identity[3]; bool closed[3];
} lc_host_qualification_toolchain;
static inline bool lc_host_qualification_member(CFArrayRef paths, const char *path, bool beneath) {
  for (CFIndex i = 0; i < CFArrayGetCount(paths); i++) {
    char value[PATH_MAX];
    if (!lc_host_text(CFArrayGetValueAtIndex(paths, i), value, sizeof(value))) return false;
    if (beneath ? lc_host_beneath(value, path) : !strcmp(value, path)) return true;
  }
  return false;
}
/* The existing threat scope trusts cooperative host-user toolchain changes.
 * Commands run as private principals with no host groups: no declared role or
 * ancestor may grant one of those principals mutation. Never repair permissions.
 * A concurrent host update changes inode/hash and requires fresh setup. */
static inline bool lc_host_qualification_role_access(const lc_host_approval *approval, const char *path) {
  char copy[PATH_MAX]; strcpy(copy, path); int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) return false;
  char *save = NULL, *part = strtok_r(copy + 1, "/", &save); bool okay = true;
  while (okay) {
    struct stat st;
    okay = !fstat(current, &st) && (st.st_uid == 0 || st.st_uid == approval->actor) &&
      !(st.st_mode & (0002 | S_ISUID | S_ISGID)) && lc_host_protected_acl(current);
    for (size_t i = 0; okay && i < approval->principal_count; i++)
      if (st.st_uid == approval->principals[i].uid || ((st.st_mode & 0020) && st.st_gid == approval->principals[i].gid)) okay = false;
    if (!okay || !part) break;
    char *next_part = strtok_r(NULL, "/", &save);
    int next = openat(current, part, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (next_part ? O_DIRECTORY : 0));
    if (close(current)) okay = false;
    current = next; if (current < 0) { okay = false; break; }
    part = next_part;
  }
  if (current >= 0 && close(current)) okay = false; return okay;
}
static inline bool lc_host_qualification_node_signature(const lc_host_qualification_toolchain *tools) {
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const unsigned char *)tools->node, strlen(tools->node), false);
  SecStaticCodeRef code = NULL; CFStringRef expected = CFStringCreateWithCString(NULL, tools->node_cdhash, kCFStringEncodingUTF8);
  bool okay = url && expected && SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess &&
    SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures, NULL) == errSecSuccess && lc_host_code_hash(code, expected);
  if (code) CFRelease(code); if (url) CFRelease(url); if (expected) CFRelease(expected); return okay;
}
static inline bool lc_host_qualification_toolchain_current(const lc_host_approval *approval, const lc_host_qualification_toolchain *tools) {
  const char *paths[] = { tools->node, tools->npm, "/bin/bash" };
  const char *hashes[] = { tools->node_sha, tools->npm_sha, tools->bash_sha };
  for (size_t i = 0; i < 3; i++) {
    struct stat held, named;
    if (tools->closed[i] || tools->fd[i] < 0 || !lc_host_absolute(paths[i]) || !lc_host_qualification_role_access(approval, paths[i]) ||
        fstat(tools->fd[i], &held) || lstat(paths[i], &named) || !S_ISREG(held.st_mode) || held.st_nlink != 1 ||
        (uint64_t)held.st_dev != tools->identity[i].device || (uint64_t)held.st_ino != tools->identity[i].inode ||
        named.st_dev != held.st_dev || named.st_ino != held.st_ino || !lc_host_sha_file(paths[i], hashes[i])) return false;
  }
  return lc_host_qualification_node_signature(tools);
}
static inline bool lc_host_qualification_toolchain_open(const lc_host_approval *approval, lc_host_qualification_toolchain *tools) {
  memset(tools, 0, sizeof(*tools)); for (size_t i = 0; i < 3; i++) tools->fd[i] = -1;
  CFTypeRef authorization = CFDictionaryGetValue(approval->manifest, CFSTR("SetupAuthorization"));
  CFTypeRef roles = authorization && CFGetTypeID(authorization) == CFDictionaryGetTypeID() ?
    CFDictionaryGetValue(authorization, CFSTR("QualificationToolchain")) : NULL;
  uint32_t version, recipe; unsigned char digest[32];
  if (!authorization || !lc_host_number(CFDictionaryGetValue(authorization, CFSTR("Version")), &version) || version != 2 ||
      !roles || CFGetTypeID(roles) != CFDictionaryGetTypeID() || CFDictionaryGetCount(roles) != 7 ||
      !lc_host_number(CFDictionaryGetValue(roles, CFSTR("RecipeVersion")), &recipe) || recipe != 1 ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("NodePath")), tools->node, sizeof(tools->node)) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("NpmCliPath")), tools->npm, sizeof(tools->npm)) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("NodeSHA256")), tools->node_sha, sizeof(tools->node_sha)) || !lc_host_unhex(tools->node_sha, digest, 32) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("NpmCliSHA256")), tools->npm_sha, sizeof(tools->npm_sha)) || !lc_host_unhex(tools->npm_sha, digest, 32) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("BashSHA256")), tools->bash_sha, sizeof(tools->bash_sha)) || !lc_host_unhex(tools->bash_sha, digest, 32) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("NodeCDHash")), tools->node_cdhash, sizeof(tools->node_cdhash)) ||
      !lc_host_qualification_member(approval->executables, tools->node, false) || !lc_host_qualification_member(approval->executables, "/bin/bash", false) ||
      !lc_host_qualification_member(approval->reads, tools->node, true) || !lc_host_qualification_member(approval->reads, tools->npm, true)) return false;
  const char *paths[] = { tools->node, tools->npm, "/bin/bash" };
  for (size_t i = 0; i < 3; i++) {
    tools->fd[i] = open(paths[i], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (tools->fd[i] < 0 || !lc_host_identity(tools->fd[i], false, &tools->identity[i])) return false;
  }
  return lc_host_qualification_toolchain_current(approval, tools);
}
static inline bool lc_host_qualification_toolchain_close(lc_host_qualification_toolchain *tools) {
  for (size_t i = 0; i < 3; i++) {
    if (tools->closed[i]) continue;
    int original = tools->fd[i]; tools->fd[i] = -1;
    if (original < 0 || close(original)) return false;
    tools->closed[i] = true;
  }
  return true;
}
#endif
