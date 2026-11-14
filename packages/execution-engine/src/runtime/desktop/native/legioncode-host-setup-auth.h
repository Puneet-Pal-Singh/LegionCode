#ifndef LEGIONCODE_HOST_SETUP_AUTH_H
#define LEGIONCODE_HOST_SETUP_AUTH_H
#include "legioncode-host-record.h"

/* Ordered setup scope, never fabricated workspace/thread/run/Turn fields. The
 * complete manifest digest additionally binds the approved bridge/resource map. */
static inline bool lc_host_setup_scope_sha256(const lc_host_approval *approval,
    const unsigned char nonce[32], const lc_host_writer_binding *binding, const char boot[40], unsigned char out[32]) {
  static const char domain[] = "LegionCode/native-host/setup-qualification/v1";
  char bundle_hash[129], broker_hash[65]; unsigned char broker[32], actor[4];
  if (binding->actor_uid != approval->actor || !lc_host_boot_field(boot) ||
      !lc_host_text(CFDictionaryGetValue(approval->manifest, CFSTR("BundleCDHash")), bundle_hash, sizeof(bundle_hash)) ||
      !lc_host_text(CFDictionaryGetValue(approval->manifest, CFSTR("BrokerSHA256")), broker_hash, sizeof(broker_hash)) ||
      !lc_host_unhex(broker_hash, broker, sizeof(broker))) return false;
  lc_host_write32(actor, approval->actor); CC_SHA256_CTX hash; CC_SHA256_Init(&hash);
  CC_SHA256_Update(&hash, domain, sizeof(domain)); CC_SHA256_Update(&hash, nonce, 32);
  CC_SHA256_Update(&hash, actor, sizeof(actor)); CC_SHA256_Update(&hash, bundle_hash, (CC_LONG)strlen(bundle_hash) + 1);
  CC_SHA256_Update(&hash, broker, sizeof(broker)); CC_SHA256_Update(&hash, binding->policy_sha256, 32);
  CC_SHA256_Update(&hash, binding->approved_policy_generation, 32);
  CC_SHA256_Update(&hash, approval->kernel_release, (CC_LONG)strlen(approval->kernel_release) + 1);
  CC_SHA256_Update(&hash, boot, 40); CC_SHA256_Update(&hash, binding->resource_id, 32);
  CC_SHA256_Update(&hash, binding->broker_resource_generation, 32);
  CC_SHA256_Update(&hash, approval->generation, (CC_LONG)strlen(approval->generation) + 1);
  CC_SHA256_Update(&hash, approval->manifest_sha256, 32); CC_SHA256_Final(out, &hash); return true;
}
static inline bool lc_host_setup_namespace(const lc_host_approval *approval, xpc_object_t request) {
  xpc_object_t value = xpc_dictionary_get_value(request, "namespaceFd");
  if (!value || xpc_get_type(value) != XPC_TYPE_FD) return false;
  int fd = xpc_fd_dup(value); if (fd < 0) return false;
  struct stat st; char path[PATH_MAX];
  bool okay = !fstat(fd, &st) && S_ISDIR(st.st_mode) && st.st_uid == approval->actor && (st.st_mode & 0777) == 0700 &&
    (uint64_t)st.st_dev == approval->writer_namespace.device && (uint64_t)st.st_ino == approval->writer_namespace.inode &&
    !fcntl(fd, F_GETPATH, path) && !strcmp(path, approval->writer_namespace_path);
  if (close(fd)) okay = false; return okay;
}
#endif
