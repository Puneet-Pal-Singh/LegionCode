#ifndef LEGIONCODE_HOST_SANDBOX_H
#define LEGIONCODE_HOST_SANDBOX_H
#include "legioncode-host-approval.h"
#include "legioncode-host-metadata.h"
#include <stdarg.h>

typedef struct { char bytes[65536]; size_t used; bool okay; } lc_host_policy_buffer;
static inline void lc_host_policy_add(lc_host_policy_buffer *out, const char *format, ...) {
  if (!out->okay) return;
  va_list args; va_start(args, format);
  int n = vsnprintf(out->bytes + out->used, sizeof(out->bytes) - out->used, format, args); va_end(args);
  if (n < 0 || (size_t)n >= sizeof(out->bytes) - out->used) { out->okay = false; return; }
  out->used += (size_t)n;
}
static inline void lc_host_policy_path(lc_host_policy_buffer *out, const char *operation,
                                      const char *filter, const char *path) {
  lc_host_policy_add(out, "(%s (%s \"", operation, filter);
  for (const unsigned char *p = (const unsigned char *)path; *p && out->okay; p++) {
    if (*p < 32 || *p == 127) { out->okay = false; return; }
    if (*p == '\\' || *p == '"') lc_host_policy_add(out, "\\%c", *p);
    else lc_host_policy_add(out, "%c", *p);
  }
  lc_host_policy_add(out, "\"))\n");
}
static inline bool lc_host_build_policy(const lc_host_approval *approval, const char *root,
                                        const char *work, const lc_host_metadata *metadata_layout, lc_host_policy_buffer *out) {
  memset(out, 0, sizeof(*out)); out->okay = true;
  if (!lc_host_absolute(root) || !lc_host_absolute(work) || lc_host_beneath(root, LC_HOST_STATE) ||
      lc_host_beneath(LC_HOST_STATE, root) || lc_host_beneath(root, approval->bundle) ||
      lc_host_beneath(approval->bundle, root)) return false;
  lc_host_policy_add(out, "(version 1)\n(deny default)\n");
  /* Children inherit the same profile. Detached processes keep their real UID;
   * lifecycle closure is independently enforced by the broker's UID scope. */
  lc_host_policy_add(out, "(allow process-fork)\n(allow process-info* (target self))\n");
  lc_host_policy_add(out, "(allow signal (target same-sandbox))\n(allow sysctl-read)\n");
  lc_host_policy_add(out, "(allow file-read-metadata)\n");
  lc_host_policy_path(out, "allow file-read*", "subpath", root);
  lc_host_policy_path(out, "allow file-read* file-write*", "subpath", work);
  lc_host_policy_path(out, "allow file-write*", "subpath", root);
  lc_host_policy_path(out, "allow process-exec", "subpath", root);
  lc_host_policy_path(out, "allow process-exec", "subpath", work);
  /* sandbox-exec re-enters this root-owned trusted bootstrap before any target.
   * Only that bootstrap drops credentials and closes inherited authority FDs. */
  lc_host_policy_path(out, "allow process-exec", "literal", LC_HOST_INSTALLED_BROKER);
  lc_host_policy_path(out, "allow file-read*", "literal", LC_HOST_INSTALLED_BROKER);
  for (CFIndex i = 0; i < CFArrayGetCount(approval->reads); i++) {
    char path[PATH_MAX];
    if (!lc_host_text(CFArrayGetValueAtIndex(approval->reads, i), path, sizeof(path)) ||
        lc_host_beneath(path, root) || lc_host_beneath(root, path) ||
        lc_host_beneath(path, LC_HOST_STATE) || lc_host_beneath(path, approval->bundle)) return false;
    lc_host_policy_path(out, "allow file-read*", "subpath", path);
    /* Trusted host mutation is outside this declared policy; tools cannot alter
     * their declared toolchains, executable permissions or code. */
    lc_host_policy_path(out, "deny file-write*", "subpath", path);
  }
  bool bash = false;
  for (CFIndex i = 0; i < CFArrayGetCount(approval->executables); i++) {
    char path[PATH_MAX];
    if (!lc_host_text(CFArrayGetValueAtIndex(approval->executables, i), path, sizeof(path))) return false;
    lc_host_policy_path(out, "allow process-exec", "literal", path);
    if (!strcmp(path, "/bin/bash")) bash = true;
  }
  for (const char **p = (const char *[]){ "/dev/null", "/dev/urandom", "/dev/random", NULL }; *p; p++)
    lc_host_policy_path(out, "allow file-read* file-write-data", "literal", *p);
  char metadata[PATH_MAX];
  if (snprintf(metadata, sizeof(metadata), "%s/.git", root) >= (int)sizeof(metadata)) return false;
  lc_host_policy_path(out, "deny file-write*", "subpath", metadata);
  for (size_t i = 0; i < LC_HOST_METADATA_PATHS; i++) {
    const char *path = metadata_layout->paths[i]; if (!path[0]) continue;
    lc_host_policy_path(out, "deny file-write* process-exec", "subpath", path);
    /* Renaming/deleting an ancestor must not move metadata out of its deny
     * prefix. Deny unlink of each ancestor, preserving ordinary child writes. */
    char ancestor[PATH_MAX]; strcpy(ancestor, path);
    while (lc_host_beneath(root, ancestor)) {
      lc_host_policy_path(out, "deny file-write-unlink", "literal", ancestor);
      if (!strcmp(root, ancestor)) break;
      char *slash = strrchr(ancestor, '/'); if (!slash) return false; *slash = 0;
    }
  }
  lc_host_policy_path(out, "deny file-read* file-write*", "subpath", LC_HOST_STATE);
  lc_host_policy_path(out, "deny file-read* file-write*", "subpath", approval->bundle);
  for (CFIndex i = 0; i < CFArrayGetCount(approval->protected_roots); i++) {
    char protected[PATH_MAX];
    if (!lc_host_text(CFArrayGetValueAtIndex(approval->protected_roots, i), protected, sizeof(protected)) ||
        lc_host_beneath(protected, root) || lc_host_beneath(root, protected) ||
        lc_host_beneath(protected, work) || lc_host_beneath(work, protected)) return false;
    lc_host_policy_path(out, "deny file-read* file-write*", "subpath", protected);
  }
  lc_host_policy_add(out, "(deny file-link)\n(deny file-write-create (require-not (require-any (vnode-type REGULAR-FILE) (vnode-type DIRECTORY))))\n");
  lc_host_policy_add(out, "(deny file-write-setugid)\n(deny file-write-owner)\n(deny file-write-security)\n");
  /* Initial command policy is network-off. Native inference stays in the host.
   * No Mach lookup/registration, IPC, credential or host-control allowances. */
  return out->okay && bash;
}
#endif
