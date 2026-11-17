#ifndef LEGIONCODE_HOST_QUALIFICATION_TOOLCHAIN_H
#define LEGIONCODE_HOST_QUALIFICATION_TOOLCHAIN_H
#include "legioncode-host-approval.h"

#define LC_HOST_PRIMARY_TOOLCHAIN_ROLES 5U
#define LC_HOST_CORE_EXECUTABLE_COUNT 7U
#define LC_HOST_TOOLCHAIN_ROLES (LC_HOST_PRIMARY_TOOLCHAIN_ROLES + LC_HOST_CORE_EXECUTABLE_COUNT)
static const char *const lc_host_core_executables[LC_HOST_CORE_EXECUTABLE_COUNT] = {
  "/bin/sh", "/bin/ls", "/bin/cat", "/bin/cp", "/bin/mkdir", "/bin/rm", "/bin/mv"
};
#define LC_HOST_TOOLCHAIN_RECIPE 2U
typedef struct {
  char node[PATH_MAX], npm[PATH_MAX], launcher[PATH_MAX];
  char node_sha[65], npm_sha[65], bash_sha[65], launcher_sha[65], env_sha[65], node_cdhash[129], env_cdhash[129];
  char core_sha[LC_HOST_CORE_EXECUTABLE_COUNT][65], core_cdhash[LC_HOST_CORE_EXECUTABLE_COUNT][129];
  int fd[LC_HOST_TOOLCHAIN_ROLES]; lc_host_file_identity identity[LC_HOST_TOOLCHAIN_ROLES]; bool closed[LC_HOST_TOOLCHAIN_ROLES];
} lc_host_qualification_toolchain;
static inline const char *lc_host_toolchain_role_path(const lc_host_qualification_toolchain *tools, size_t index) {
  switch (index) {
    case 0: return tools->node; case 1: return tools->npm; case 2: return "/bin/bash";
    case 3: return tools->launcher; case 4: return LC_HOST_ENV_EXECUTABLE;
    default: return index < LC_HOST_TOOLCHAIN_ROLES ? lc_host_core_executables[index - LC_HOST_PRIMARY_TOOLCHAIN_ROLES] : NULL;
  }
}
static inline const char *lc_host_toolchain_role_hash(const lc_host_qualification_toolchain *tools, size_t index) {
  switch (index) {
    case 0: return tools->node_sha; case 1: return tools->npm_sha; case 2: return tools->bash_sha;
    case 3: return tools->launcher_sha; case 4: return tools->env_sha;
    default: return index < LC_HOST_TOOLCHAIN_ROLES ? tools->core_sha[index - LC_HOST_PRIMARY_TOOLCHAIN_ROLES] : NULL;
  }
}
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
static inline bool lc_host_qualification_signature(const char *path, const char *cdhash) {
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const unsigned char *)path, strlen(path), false);
  SecStaticCodeRef code = NULL; CFStringRef expected = CFStringCreateWithCString(NULL, cdhash, kCFStringEncodingUTF8);
  bool okay = url && expected && SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess &&
    SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures, NULL) == errSecSuccess && lc_host_code_hash(code, expected);
  if (code) CFRelease(code); if (url) CFRelease(url); if (expected) CFRelease(expected); return okay;
}
static inline bool lc_host_toolchain_quote(const char *text, char *out, size_t bound) {
  size_t at = 0; if (bound < 3) return false; out[at++] = 39;
  for (const char *p = text; *p; p++) {
    size_t size = *p == 39 ? 4 : 1; if (at + size + 2 > bound) return false;
    if (*p == 39) { out[at++] = 39; out[at++] = 92; out[at++] = 39; out[at++] = 39; }
    else out[at++] = *p;
  }
  out[at++] = 39; out[at] = 0; return true;
}
static inline bool lc_host_npm_launcher_bytes(const lc_host_qualification_toolchain *tools, char *out, size_t bound) {
  char node[PATH_MAX * 4], npm[PATH_MAX * 4];
  if (!lc_host_toolchain_quote(tools->node, node, sizeof(node)) || !lc_host_toolchain_quote(tools->npm, npm, sizeof(npm))) return false;
  int count = snprintf(out, bound, "#!/bin/bash\nexec %s %s \"$@\"\n", node, npm);
  return count > 0 && (size_t)count < bound;
}
static inline bool lc_host_qualification_toolchain_parse(const lc_host_approval *approval, lc_host_qualification_toolchain *tools) {
  memset(tools, 0, sizeof(*tools)); for (size_t i = 0; i < LC_HOST_TOOLCHAIN_ROLES; i++) tools->fd[i] = -1;
  CFTypeRef authorization = CFDictionaryGetValue(approval->manifest, CFSTR("SetupAuthorization"));
  CFTypeRef roles = authorization && CFGetTypeID(authorization) == CFDictionaryGetTypeID() ?
    CFDictionaryGetValue(authorization, CFSTR("QualificationToolchain")) : NULL;
  uint32_t version, recipe; unsigned char digest[32];
  if (!authorization || !lc_host_number(CFDictionaryGetValue(authorization, CFSTR("Version")), &version) || version != 2 ||
      !roles || CFGetTypeID(roles) != CFDictionaryGetTypeID() || CFDictionaryGetCount(roles) != 11 ||
      !lc_host_number(CFDictionaryGetValue(roles, CFSTR("RecipeVersion")), &recipe) || recipe != LC_HOST_TOOLCHAIN_RECIPE ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("NodePath")), tools->node, sizeof(tools->node)) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("NpmCliPath")), tools->npm, sizeof(tools->npm)) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("NpmLauncherPath")), tools->launcher, sizeof(tools->launcher)) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("NodeSHA256")), tools->node_sha, sizeof(tools->node_sha)) || !lc_host_unhex(tools->node_sha, digest, 32) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("NpmCliSHA256")), tools->npm_sha, sizeof(tools->npm_sha)) || !lc_host_unhex(tools->npm_sha, digest, 32) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("BashSHA256")), tools->bash_sha, sizeof(tools->bash_sha)) || !lc_host_unhex(tools->bash_sha, digest, 32) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("NpmLauncherSHA256")), tools->launcher_sha, sizeof(tools->launcher_sha)) || !lc_host_unhex(tools->launcher_sha, digest, 32) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("EnvSHA256")), tools->env_sha, sizeof(tools->env_sha)) || !lc_host_unhex(tools->env_sha, digest, 32) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("NodeCDHash")), tools->node_cdhash, sizeof(tools->node_cdhash)) ||
      !lc_host_text(CFDictionaryGetValue(roles, CFSTR("EnvCDHash")), tools->env_cdhash, sizeof(tools->env_cdhash))) return false;
  CFTypeRef cores = CFDictionaryGetValue(approval->manifest, CFSTR("CoreExecutables"));
  if (!cores || CFGetTypeID(cores) != CFDictionaryGetTypeID() || CFDictionaryGetCount(cores) != LC_HOST_CORE_EXECUTABLE_COUNT) return false;
  for (size_t i = 0; i < LC_HOST_CORE_EXECUTABLE_COUNT; i++) {
    CFStringRef key = CFStringCreateWithCString(NULL, lc_host_core_executables[i], kCFStringEncodingUTF8);
    CFTypeRef entry = key ? CFDictionaryGetValue(cores, key) : NULL; if (key) CFRelease(key);
    if (!entry || CFGetTypeID(entry) != CFDictionaryGetTypeID() || CFDictionaryGetCount(entry) != 2 ||
        !lc_host_text(CFDictionaryGetValue(entry, CFSTR("SHA256")), tools->core_sha[i], sizeof(tools->core_sha[i])) ||
        !lc_host_unhex(tools->core_sha[i], digest, 32) ||
        !lc_host_text(CFDictionaryGetValue(entry, CFSTR("CDHash")), tools->core_cdhash[i], sizeof(tools->core_cdhash[i]))) return false;
  }
  const char *node_name = strrchr(tools->node, '/'), *launcher_name = strrchr(tools->launcher, '/');
  if (CFArrayGetCount(approval->executables) != 4 + LC_HOST_CORE_EXECUTABLE_COUNT || !node_name || strcmp(node_name + 1, "node") || !launcher_name || strcmp(launcher_name + 1, "npm")) return false;
  for (size_t i = 0; i < LC_HOST_TOOLCHAIN_ROLES; i++) {
    const char *path = lc_host_toolchain_role_path(tools, i);
    if (!path || !lc_host_absolute(path) || strchr(path, ':') ||
        !lc_host_qualification_member(approval->reads, path, true) ||
        (i != 1 && !lc_host_qualification_member(approval->executables, path, false))) return false;
    for (const unsigned char *p = (const unsigned char *)path; *p; p++) if (*p < 32 || *p == 127) return false;
  }
  return true;
}
/* The SAME role-derived path is captured for ordinary Native commands and the
 * fixed qualifier. No host PATH, cwd, arbitrary executable directory or fallback
 * is inherited. npm's TREE is not a launcher: put its declared bin first. */
static inline bool lc_host_command_path(const lc_host_approval *approval, char *out, size_t bound) {
  lc_host_qualification_toolchain tools;
  if (bound < 2) return false;
  if (!lc_host_qualification_toolchain_parse(approval, &tools)) return false;
  const char *roles[] = { tools.launcher, tools.node, LC_HOST_ENV_EXECUTABLE, "/bin/bash" };
  char previous[4][PATH_MAX]; size_t directories = 0, used = 0; out[0] = 0;
  for (size_t i = 0; i < 4; i++) {
    char path[PATH_MAX]; strcpy(path, roles[i]); char *slash = strrchr(path, '/');
    if (!slash || slash == path) return false; *slash = 0;
    bool repeated = false; for (size_t j = 0; j < directories; j++) if (!strcmp(previous[j], path)) repeated = true;
    if (repeated) continue;
    int count = snprintf(out + used, bound - used, "%s%s", used ? ":" : "", path);
    if (count < 0 || (size_t)count >= bound - used) return false;
    used += (size_t)count; strcpy(previous[directories++], path);
  }
  return used != 0;
}
static inline bool lc_host_qualification_toolchain_current(const lc_host_approval *approval, const lc_host_qualification_toolchain *tools) {
  for (size_t i = 0; i < LC_HOST_TOOLCHAIN_ROLES; i++) {
    const char *path = lc_host_toolchain_role_path(tools, i), *sha = lc_host_toolchain_role_hash(tools, i);
    struct stat held, named;
    if (!path || !sha || tools->closed[i] || tools->fd[i] < 0 || !lc_host_absolute(path) || !lc_host_qualification_role_access(approval, path) ||
        fstat(tools->fd[i], &held) || lstat(path, &named) || !S_ISREG(held.st_mode) || held.st_nlink != 1 ||
        (uint64_t)held.st_dev != tools->identity[i].device || (uint64_t)held.st_ino != tools->identity[i].inode ||
        named.st_dev != held.st_dev || named.st_ino != held.st_ino || !lc_host_sha_file(path, sha)) return false;
    if (i >= 2 && held.st_uid != 0) return false;
    if (i == 3) {
      char expected[PATH_MAX * 8 + 64], actual[PATH_MAX * 8 + 64];
      if ((held.st_mode & 07777) != 0555 || !lc_host_npm_launcher_bytes(tools, expected, sizeof(expected)) || held.st_size != (off_t)strlen(expected)) return false;
      ssize_t count; do { count = pread(tools->fd[i], actual, strlen(expected), 0); } while (count < 0 && errno == EINTR);
      if (count != (ssize_t)strlen(expected) || memcmp(actual, expected, strlen(expected))) return false;
    }
  }
  if (!lc_host_qualification_signature(tools->node, tools->node_cdhash) || !lc_host_qualification_signature(LC_HOST_ENV_EXECUTABLE, tools->env_cdhash)) return false;
  for (size_t i = 0; i < LC_HOST_CORE_EXECUTABLE_COUNT; i++)
    if (!lc_host_qualification_signature(lc_host_core_executables[i], tools->core_cdhash[i])) return false;
  return true;
}
static inline bool lc_host_qualification_toolchain_open(const lc_host_approval *approval, lc_host_qualification_toolchain *tools) {
  if (!lc_host_qualification_toolchain_parse(approval, tools)) return false;
  for (size_t i = 0; i < LC_HOST_TOOLCHAIN_ROLES; i++) {
    tools->fd[i] = open(lc_host_toolchain_role_path(tools, i), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (tools->fd[i] < 0 || !lc_host_identity(tools->fd[i], false, &tools->identity[i])) return false;
  }
  return lc_host_qualification_toolchain_current(approval, tools);
}
static inline bool lc_host_qualification_toolchain_close(lc_host_qualification_toolchain *tools) {
  for (size_t i = 0; i < LC_HOST_TOOLCHAIN_ROLES; i++) {
    if (tools->closed[i]) continue;
    int original = tools->fd[i]; tools->fd[i] = -1;
    if (original < 0 || close(original)) return false;
    tools->closed[i] = true;
  }
  return true;
}
#endif
