#ifndef LEGIONCODE_HOST_APPROVAL_H
#define LEGIONCODE_HOST_APPROVAL_H
#include "legioncode-host-contract.h"

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
  bool qualified, platform_matches, setup_authorized;
  char setup_permit_id[65], writer_namespace_path[PATH_MAX];
  lc_host_file_identity writer_namespace;
  unsigned char manifest_sha256[32];
} lc_host_approval;

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
static inline bool lc_host_paths(CFTypeRef value, CFArrayRef *out, bool executables) {
  if (!value || CFGetTypeID(value) != CFArrayGetTypeID() || !CFArrayGetCount(value) || CFArrayGetCount(value) > 32) return false;
  for (CFIndex i = 0; i < CFArrayGetCount(value); i++) {
    char path[PATH_MAX]; struct stat st;
    if (!lc_host_text(CFArrayGetValueAtIndex(value, i), path, sizeof(path)) || !lc_host_absolute(path) ||
        stat(path, &st) || (st.st_mode & (S_ISUID | S_ISGID)) ||
        (executables ? (!S_ISREG(st.st_mode) || !(st.st_mode & 0111)) : !S_ISDIR(st.st_mode))) return false;
  }
  *out = value; return true;
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
  if (!lc_host_number(CFDictionaryGetValue(raw, CFSTR("Version")), &version) || version != 1 ||
      !lc_host_text(CFDictionaryGetValue(raw, CFSTR("PermitId")), out->setup_permit_id, sizeof(out->setup_permit_id)) ||
      !lc_host_unhex(out->setup_permit_id, permit, sizeof(permit)) ||
      !lc_host_text(CFDictionaryGetValue(raw, CFSTR("WriterNamespacePath")), out->writer_namespace_path, sizeof(out->writer_namespace_path)) ||
      !lc_host_absolute(out->writer_namespace_path) ||
      !lc_host_manifest_u64(raw, CFSTR("WriterNamespaceDevice"), &out->writer_namespace.device) ||
      !lc_host_manifest_u64(raw, CFSTR("WriterNamespaceInode"), &out->writer_namespace.inode) || !out->writer_namespace.inode) return false;
  for (size_t i = 0; i < sizeof(permit); i++) nonzero |= permit[i];
  if (!nonzero) return false;
  out->setup_authorized = true; return true;
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
      !lc_host_paths(CFDictionaryGetValue(values, CFSTR("ReadRoots")), &out->reads, false) ||
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
   * Its producer/validator is not joined until canonical setup transport exists. */
  out->qualified = false;
  unsigned char random[32]; arc4random_buf(random, sizeof(random)); lc_host_hex(random, sizeof(random), out->generation, sizeof(out->generation));
  return true;
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
