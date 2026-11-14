#ifndef LEGIONCODE_HOST_APPROVAL_H
#define LEGIONCODE_HOST_APPROVAL_H
#include "legioncode-host-contract.h"
#include <stddef.h>
#define LC_HOST_ENV_EXECUTABLE "/usr/bin/env"

typedef struct { uid_t uid; gid_t gid; uuid_t guid; } lc_host_principal;
typedef struct {
  uid_t actor;
  char bundle[PATH_MAX], bridge[PATH_MAX], policy[65], policy_generation[65], generation[65];
  char kernel_release[256];
  CFDictionaryRef manifest;
  CFArrayRef reads, executables, protected_roots;
  SecRequirementRef bundle_requirement, bridge_requirement;
  lc_host_principal principals[LC_HOST_MAX_PRINCIPALS];
  size_t principal_count;
  bool qualified, platform_matches, setup_authorized, reauthorization_sealed;
  char setup_permit_id[65], writer_namespace_path[PATH_MAX];
  lc_host_file_identity writer_namespace;
  unsigned char manifest_sha256[32];
} lc_host_approval;

/* This is a deny-only configuration transition receipt in the SAME protected
 * setup authority. It never authorizes execution, cleanup or UID reuse. The
 * installer may rotate an exact immutable manifest only after READY. */
#define LC_HOST_REAUTHORIZATION_SEAL_VERSION 1U
#define LC_HOST_REAUTHORIZATION_PENDING 1U
#define LC_HOST_REAUTHORIZATION_READY 2U
typedef struct {
  uint32_t version, bytes, actor, phase;
  char boot[40], generation[65];
  lc_host_file_identity namespace;
  unsigned char configuration_sha256[32], policy_sha256[32], policy_generation[32];
  uint64_t resource_count, slot_count, permit_count;
  unsigned char history_sha256[32];
  _Alignas(8) unsigned char digest[32];
} lc_host_reauthorization_seal;
_Static_assert(offsetof(lc_host_reauthorization_seal, digest) + 32 == sizeof(lc_host_reauthorization_seal),
  "Reauthorization digest covers complete receipt");
static inline bool lc_host_reauthorization_name(const unsigned char configuration[32], char name[96]) {
  char digest[65]; return lc_host_hex(configuration, 32, digest, sizeof(digest)) &&
    snprintf(name, 96, "setup-seal.%s", digest) < 96;
}
static inline bool lc_host_reauthorization_boot_field(const char boot[40]) {
  if (boot[36] || boot[37] || boot[38] || boot[39]) return false;
  for (size_t i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (boot[i] != '-') return false; }
    else if (!((boot[i] >= '0' && boot[i] <= '9') || (boot[i] >= 'a' && boot[i] <= 'f'))) return false;
  }
  return true;
}
static inline bool lc_host_reauthorization_seal_read(const lc_host_approval *approval,
    const unsigned char configuration[32], lc_host_reauthorization_seal *record, bool *present) {
  char name[96], path[PATH_MAX]; struct stat st; *present = false;
  if (!lc_host_reauthorization_name(configuration, name) ||
      snprintf(path, sizeof(path), "%s/%s", LC_HOST_STATE, name) >= (int)sizeof(path)) return false;
  errno = 0;
  if (lstat(path, &st)) return errno == ENOENT;
  *present = true; int fd = lc_host_open_protected(path, false); if (fd < 0) return false;
  memset(record, 0, sizeof(*record));
  bool okay = !fstat(fd, &st) && st.st_nlink == 1 && (st.st_mode & 07777) == 0600 &&
    st.st_size == sizeof(*record) && lc_host_io(fd, record, sizeof(*record), false);
  if (close(fd)) okay = false;
  unsigned char hash[32], policy[32], generation[32], history = 0;
  for (size_t i = 0; i < 32; i++) history |= record->history_sha256[i];
  CC_SHA256(record, (CC_LONG)offsetof(lc_host_reauthorization_seal, digest), hash);
  return okay && record->version == LC_HOST_REAUTHORIZATION_SEAL_VERSION && record->bytes == sizeof(*record) &&
    record->actor == approval->actor && (record->phase == LC_HOST_REAUTHORIZATION_PENDING ?
      !record->resource_count && !record->slot_count && !record->permit_count && !history :
      record->phase == LC_HOST_REAUTHORIZATION_READY && history) &&
    lc_host_reauthorization_boot_field(record->boot) &&
    memchr(record->generation, 0, sizeof(record->generation)) && lc_host_unhex(record->generation, generation, 32) &&
    lc_host_same(record->namespace, approval->writer_namespace) && !memcmp(record->configuration_sha256, configuration, 32) &&
    lc_host_unhex(approval->policy, policy, 32) && !memcmp(record->policy_sha256, policy, 32) &&
    lc_host_unhex(approval->policy_generation, generation, 32) && !memcmp(record->policy_generation, generation, 32) &&
    !memcmp(record->digest, hash, 32);
}
static inline bool lc_host_reauthorization_load(lc_host_approval *approval) {
  char name[96], next[PATH_MAX]; struct stat st;
  if (!lc_host_reauthorization_name(approval->manifest_sha256, name) ||
      snprintf(next, sizeof(next), "%s/%s.next", LC_HOST_STATE, name) >= (int)sizeof(next)) return false;
  errno = 0; if (!lstat(next, &st) || errno != ENOENT) return false;
  lc_host_reauthorization_seal record; bool present;
  if (!lc_host_reauthorization_seal_read(approval, approval->manifest_sha256, &record, &present)) return false;
  approval->reauthorization_sealed = present; return true;
}

static inline bool lc_host_sha_file(const char *path, const char *expected) {
  unsigned char digest[32], buffer[32768]; char hex[65];
  if (!lc_host_absolute(path) || !expected || strlen(expected) != 64) return false;
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); struct stat st;
  if (fd < 0) return false;
  bool okay = !fstat(fd, &st) && S_ISREG(st.st_mode) && st.st_size >= 0 && st.st_size <= 512 * 1024 * 1024;
  CC_SHA256_CTX context; CC_SHA256_Init(&context);
  while (okay) {
    ssize_t n = read(fd, buffer, sizeof(buffer));
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) okay = false;
    if (n <= 0) break;
    CC_SHA256_Update(&context, buffer, (CC_LONG)n);
  }
  if (close(fd)) okay = false;
  CC_SHA256_Final(digest, &context); lc_host_hex(digest, sizeof(digest), hex, sizeof(hex));
  return okay && !strcmp(hex, expected);
}
static inline bool lc_host_requirement(CFDictionaryRef values, CFStringRef key, SecRequirementRef *out) {
  CFTypeRef value = CFDictionaryGetValue(values, key);
  return value && CFGetTypeID(value) == CFStringGetTypeID() &&
    SecRequirementCreateWithString(value, kSecCSDefaultFlags, out) == errSecSuccess;
}
static inline bool lc_host_installed_broker_valid(const lc_host_approval *approval) {
  char expected[65];
  if (!lc_host_text(CFDictionaryGetValue(approval->manifest, CFSTR("BrokerSHA256")), expected, sizeof(expected))) return false;
  int fd = lc_host_open_protected(LC_HOST_INSTALLED_BROKER, false);
  if (fd < 0) return false;
  bool okay = lc_host_sha_file(LC_HOST_INSTALLED_BROKER, expected);
  if (close(fd)) okay = false;
  return okay;
}
static inline bool lc_host_code_hash(SecStaticCodeRef code, CFTypeRef expected) {
  char text[129], actual[129];
  if (!lc_host_text(expected, text, sizeof(text))) return false;
  CFDictionaryRef info = NULL;
  if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) != errSecSuccess) return false;
  CFDataRef hash = CFDictionaryGetValue(info, kSecCodeInfoUnique);
  bool okay = hash && CFGetTypeID(hash) == CFDataGetTypeID() && CFDataGetLength(hash) > 0 &&
    CFDataGetLength(hash) <= 64 && lc_host_hex(CFDataGetBytePtr(hash), (size_t)CFDataGetLength(hash), actual, sizeof(actual)) &&
    !strcmp(text, actual);
  CFRelease(info); return okay;
}
static inline bool lc_host_bundle_valid(lc_host_approval *approval) {
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const unsigned char *)approval->bundle,
    (CFIndex)strlen(approval->bundle), true);
  SecStaticCodeRef code = NULL;
  if (!url) return false;
  OSStatus result = SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code); CFRelease(url);
  if (result != errSecSuccess) return false;
  result = SecStaticCodeCheckValidity(code,
    kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate, approval->bundle_requirement);
  bool okay = result == errSecSuccess && lc_host_code_hash(code, CFDictionaryGetValue(approval->manifest, CFSTR("BundleCDHash")));
  CFRelease(code);
  CFTypeRef raw = CFDictionaryGetValue(approval->manifest, CFSTR("ResourceSHA256"));
  if (!okay || !raw || CFGetTypeID(raw) != CFDictionaryGetTypeID()) return false;
  CFDictionaryRef resources = raw;
  if (CFDictionaryGetCount(resources) < 2 || CFDictionaryGetCount(resources) > 64 ||
      !CFDictionaryContainsKey(resources, CFSTR("Contents/Resources/app.asar"))) return false;
  const void *keys[64], *values[64]; CFDictionaryGetKeysAndValues(resources, keys, values);
  bool bridge_found = false;
  for (CFIndex i = 0; i < CFDictionaryGetCount(resources); i++) {
    char relative[PATH_MAX], digest[65], path[PATH_MAX];
    if (!lc_host_text(keys[i], relative, sizeof(relative)) || !lc_host_text(values[i], digest, sizeof(digest)) ||
        relative[0] == '/' || strstr(relative, "..") ||
        snprintf(path, sizeof(path), "%s/%s", approval->bundle, relative) >= (int)sizeof(path) ||
        !lc_host_beneath(approval->bundle, path) || !lc_host_sha_file(path, digest)) return false;
    if (!strcmp(path, approval->bridge)) bridge_found = true;
  }
  return bridge_found;
}
static inline bool lc_host_declared_paths(CFTypeRef value, CFArrayRef *out, bool executables, bool env_read_leaf) {
  if (!value || CFGetTypeID(value) != CFArrayGetTypeID() || !CFArrayGetCount(value) || CFArrayGetCount(value) > 32) return false;
  for (CFIndex i = 0; i < CFArrayGetCount(value); i++) {
    char path[PATH_MAX]; struct stat st;
    if (!lc_host_text(CFArrayGetValueAtIndex(value, i), path, sizeof(path)) || !lc_host_absolute(path) ||
        stat(path, &st) || (st.st_mode & (S_ISUID | S_ISGID)) ||
        (executables ? (!S_ISREG(st.st_mode) || !(st.st_mode & 0111)) :
          (!S_ISDIR(st.st_mode) && !(env_read_leaf && !strcmp(path, LC_HOST_ENV_EXECUTABLE) && S_ISREG(st.st_mode))))) return false;
  }
  *out = value; return true;
}
static inline bool lc_host_paths(CFTypeRef value, CFArrayRef *out, bool executables) {
  return lc_host_declared_paths(value, out, executables, false);
}
/* Only the fixed, explicitly pinned env interpreter may be a read leaf. Other
 * read roots remain directories; protected roots do not acquire file semantics. */
static inline bool lc_host_read_paths(CFTypeRef value, CFArrayRef *out) {
  return lc_host_declared_paths(value, out, false, true);
}
static inline bool lc_host_manifest_u64(CFDictionaryRef values, CFStringRef key, uint64_t *out) {
  CFTypeRef value = CFDictionaryGetValue(values, key); int64_t number;
  if (!value || CFGetTypeID(value) != CFNumberGetTypeID() || !CFNumberGetValue(value, kCFNumberSInt64Type, &number) || number < 0) return false;
  *out = (uint64_t)number; return true;
}
static inline bool lc_host_setup_authorization(lc_host_approval *out) {
  CFTypeRef raw = CFDictionaryGetValue(out->manifest, CFSTR("SetupAuthorization"));
  if (!raw) return true;
  if (CFGetTypeID(raw) != CFDictionaryGetTypeID()) return false;
  uint32_t version; unsigned char permit[32], nonzero = 0;
  if (!lc_host_number(CFDictionaryGetValue(raw, CFSTR("Version")), &version) || (version != 1 && version != 2) ||
      !lc_host_text(CFDictionaryGetValue(raw, CFSTR("PermitId")), out->setup_permit_id, sizeof(out->setup_permit_id)) ||
      !lc_host_unhex(out->setup_permit_id, permit, sizeof(permit)) ||
      !lc_host_text(CFDictionaryGetValue(raw, CFSTR("WriterNamespacePath")), out->writer_namespace_path, sizeof(out->writer_namespace_path)) ||
      !lc_host_absolute(out->writer_namespace_path) ||
      !lc_host_manifest_u64(raw, CFSTR("WriterNamespaceDevice"), &out->writer_namespace.device) ||
      !lc_host_manifest_u64(raw, CFSTR("WriterNamespaceInode"), &out->writer_namespace.inode) || !out->writer_namespace.inode) return false;
  for (size_t i = 0; i < sizeof(permit); i++) nonzero |= permit[i];
  if (!nonzero) return false;
  out->setup_authorized = version == 2; return true;
}
static inline bool lc_host_load_approval(lc_host_approval *out) {
  memset(out, 0, sizeof(*out));
  int fd = lc_host_open_protected(LC_HOST_APPROVAL, false); struct stat st;
  if (fd < 0) return false;
  if (fstat(fd, &st) || st.st_size <= 0 || st.st_size > 65536) { close(fd); return false; }
  unsigned char *bytes = malloc((size_t)st.st_size);
  if (!bytes) { close(fd); return false; }
  bool okay = lc_host_io(fd, bytes, (size_t)st.st_size, false); close(fd);
  if (okay) CC_SHA256(bytes, (CC_LONG)st.st_size, out->manifest_sha256);
  CFDataRef data = okay ? CFDataCreate(NULL, bytes, st.st_size) : NULL; free(bytes);
  if (!data) return false;
  CFPropertyListRef values = CFPropertyListCreateWithData(NULL, data, kCFPropertyListImmutable, NULL, NULL); CFRelease(data);
  if (!values || CFGetTypeID(values) != CFDictionaryGetTypeID()) { if (values) CFRelease(values); return false; }
  out->manifest = values;
  uint32_t version, actor;
  if (!lc_host_number(CFDictionaryGetValue(values, CFSTR("Version")), &version) || version != LC_HOST_ABI ||
      !lc_host_number(CFDictionaryGetValue(values, CFSTR("ActorUID")), &actor) || actor < 501 ||
      !lc_host_text(CFDictionaryGetValue(values, CFSTR("BundlePath")), out->bundle, sizeof(out->bundle)) ||
      !lc_host_text(CFDictionaryGetValue(values, CFSTR("BridgePath")), out->bridge, sizeof(out->bridge)) ||
      !lc_host_absolute(out->bundle) || !lc_host_absolute(out->bridge) || !lc_host_beneath(out->bundle, out->bridge) ||
      !lc_host_text(CFDictionaryGetValue(values, CFSTR("PolicySHA256")), out->policy, sizeof(out->policy)) || strlen(out->policy) != 64 ||
      !lc_host_text(CFDictionaryGetValue(values, CFSTR("PolicyGeneration")), out->policy_generation, sizeof(out->policy_generation)) || strlen(out->policy_generation) != 64 ||
      !lc_host_text(CFDictionaryGetValue(values, CFSTR("KernelRelease")), out->kernel_release, sizeof(out->kernel_release)) ||
      !lc_host_requirement(values, CFSTR("BundleRequirement"), &out->bundle_requirement) ||
      !lc_host_requirement(values, CFSTR("BridgeRequirement"), &out->bridge_requirement) ||
      !lc_host_read_paths(CFDictionaryGetValue(values, CFSTR("ReadRoots")), &out->reads) ||
      !lc_host_paths(CFDictionaryGetValue(values, CFSTR("ProtectedRoots")), &out->protected_roots, false) ||
      !lc_host_paths(CFDictionaryGetValue(values, CFSTR("Executables")), &out->executables, true)) return false;
  out->actor = (uid_t)actor;
  CFTypeRef raw = CFDictionaryGetValue(values, CFSTR("Principals"));
  if (!raw || CFGetTypeID(raw) != CFArrayGetTypeID() || CFArrayGetCount(raw) <= 0 || CFArrayGetCount(raw) > LC_HOST_MAX_PRINCIPALS) return false;
  for (CFIndex i = 0; i < CFArrayGetCount(raw); i++) {
    CFTypeRef record = CFArrayGetValueAtIndex(raw, i); uint32_t uid, gid; char uuid[37];
    if (!record || CFGetTypeID(record) != CFDictionaryGetTypeID() ||
        !lc_host_number(CFDictionaryGetValue(record, CFSTR("UID")), &uid) || uid <= 501 || uid == actor ||
        !lc_host_number(CFDictionaryGetValue(record, CFSTR("GID")), &gid) || gid <= 501 ||
        !lc_host_text(CFDictionaryGetValue(record, CFSTR("GUID")), uuid, sizeof(uuid)) ||
        uuid_parse(uuid, out->principals[i].guid) || uuid_is_null(out->principals[i].guid)) return false;
    for (CFIndex j = 0; j < i; j++) if (out->principals[j].uid == uid || out->principals[j].gid == gid ||
        !memcmp(out->principals[j].guid, out->principals[i].guid, sizeof(uuid_t))) return false;
    out->principals[i].uid = (uid_t)uid; out->principals[i].gid = (gid_t)gid; out->principal_count++;
  }
  char kernel[256]; size_t size = sizeof(kernel);
  out->platform_matches = !sysctlbyname("kern.osrelease", kernel, &size, NULL, 0) &&
    memchr(kernel, 0, sizeof(kernel)) && !strcmp(kernel, out->kernel_release) && lc_host_bundle_valid(out);
  if (!lc_host_setup_authorization(out)) return false;
  /* A manifest boolean is not sandbox/process/cleanup evidence. Only the
   * completed protected qualification receipt may authorize normal execution.
   * Each daemon starts unqualified; only this instance's actual setup runner
   * may publish/validate its current-boot receipt. Never revive prior instances. */
  out->qualified = false;
  unsigned char random[32]; arc4random_buf(random, sizeof(random)); lc_host_hex(random, sizeof(random), out->generation, sizeof(out->generation));
  return lc_host_reauthorization_load(out);
}
static inline bool lc_host_authorize(lc_host_approval *approval, xpc_connection_t peer, xpc_object_t message) {
  uid_t uid = xpc_connection_get_euid(peer);
  if (uid != approval->actor) return false;
  for (size_t i = 0; i < approval->principal_count; i++) if (uid == approval->principals[i].uid) return false;
  SecCodeRef code = NULL; SecStaticCodeRef disk = NULL; CFURLRef path = NULL; bool okay = false;
  if (SecCodeCreateWithXPCMessage(message, kSecCSDefaultFlags, &code) != errSecSuccess ||
      SecCodeCheckValidity(code, kSecCSStrictValidate, approval->bridge_requirement) != errSecSuccess ||
      SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &disk) != errSecSuccess ||
      !lc_host_code_hash(disk, CFDictionaryGetValue(approval->manifest, CFSTR("BridgeCDHash"))) ||
      SecCodeCopyPath(code, kSecCSDefaultFlags, &path) != errSecSuccess) goto done;
  char actual[PATH_MAX];
  okay = CFURLGetFileSystemRepresentation(path, true, (unsigned char *)actual, sizeof(actual)) &&
    !strcmp(actual, approval->bridge) && lc_host_bundle_valid(approval);
done:
  if (path) CFRelease(path); if (disk) CFRelease(disk); if (code) CFRelease(code); return okay;
}
#endif
