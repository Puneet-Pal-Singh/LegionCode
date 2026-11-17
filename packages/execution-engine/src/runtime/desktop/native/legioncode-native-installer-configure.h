#ifndef LEGIONCODE_NATIVE_INSTALLER_CONFIGURE_H
#define LEGIONCODE_NATIVE_INSTALLER_CONFIGURE_H
#include <pwd.h>
#include <dirent.h>

#define LC_INSTALL_TOOLCHAIN LC_INSTALL_DIRECTORY "/toolchain"
/* Fixed Recipe 2 bytes independently verified by the C qualification owner.
 * No selected source text or ambient PATH participates in this launcher. */
static bool cfg_install_npm_launcher(int toolchain) {
  static const char launcher[] = "#!/bin/bash\nexec '" LC_INSTALL_TOOLCHAIN "/node' '"
    LC_INSTALL_TOOLCHAIN "/npm/bin/npm-cli.js' \"$@\"\n";
  int bin = install_directory(toolchain, "bin", 0755);
  bool okay = bin >= 0 && install_write(bin, "npm", launcher, sizeof(launcher) - 1, 0555);
  if (bin >= 0 && close(bin)) okay = false;
  return okay;
}
static CFMutableDictionaryRef cfg_dictionary(void) {
  return CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
}
static CFMutableArrayRef cfg_array(void) { return CFArrayCreateMutable(NULL, 0, &kCFTypeArrayCallBacks); }
static CFStringRef cfg_string(const char *value) { return CFStringCreateWithCString(NULL, value, kCFStringEncodingUTF8); }
/* An allocation failure must abort with the durable pending marker intact,
 * never publish a policy/account intent missing a mandatory field. */
static void cfg_put_string(CFMutableDictionaryRef dictionary, CFStringRef key, const char *value) {
  CFStringRef string = cfg_string(value); if (!string) _exit(78);
  CFDictionarySetValue(dictionary, key, string); CFRelease(string);
}
static void cfg_put_number(CFMutableDictionaryRef dictionary, CFStringRef key, int64_t value) {
  CFNumberRef number = CFNumberCreate(NULL, kCFNumberSInt64Type, &value);
  if (!number) _exit(78);
  CFDictionarySetValue(dictionary, key, number); CFRelease(number);
}
static bool cfg_write_plist(int parent, const char *name, CFPropertyListRef value) {
  CFDataRef data = CFPropertyListCreateData(NULL, value, kCFPropertyListXMLFormat_v1_0, 0, NULL);
  bool okay = data && CFDataGetLength(data) > 0 && CFDataGetLength(data) <= 65536 &&
    install_write(parent, name, CFDataGetBytePtr(data), (size_t)CFDataGetLength(data), 0600);
  if (data) CFRelease(data); return okay;
}
static bool cfg_sha_path(const char *path, char hex[65]) {
  int fd = lc_host_open_protected(path, false); struct stat st;
  if (fd < 0) return false;
  bool okay = !fstat(fd, &st) && st.st_size >= 0 && st.st_size <= 512U * 1024U * 1024U;
  CC_SHA256_CTX hash; CC_SHA256_Init(&hash);
  while (okay) {
    unsigned char bytes[32768]; ssize_t n = read(fd, bytes, sizeof(bytes));
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) okay = false;
    if (n <= 0) break;
    CC_SHA256_Update(&hash, bytes, (CC_LONG)n);
  }
  unsigned char digest[32]; CC_SHA256_Final(digest, &hash); lc_host_hex(digest, 32, hex, 65);
  if (close(fd)) okay = false; return okay;
}
static bool cfg_code_identity(const char *path, bool bundle, char hash[129], char requirement[180]) {
  int held = lc_host_open_protected(path, bundle);
  if (held < 0) return false;
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const unsigned char *)path, strlen(path), bundle);
  SecStaticCodeRef code = NULL; CFDictionaryRef information = NULL;
  bool okay = url && SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess &&
    SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures |
      (bundle ? kSecCSCheckNestedCode : 0), NULL) == errSecSuccess &&
    SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information) == errSecSuccess;
  CFDataRef bytes = okay ? CFDictionaryGetValue(information, kSecCodeInfoUnique) : NULL;
  okay = bytes && CFGetTypeID(bytes) == CFDataGetTypeID() && CFDataGetLength(bytes) > 0 && CFDataGetLength(bytes) <= 64 &&
    lc_host_hex(CFDataGetBytePtr(bytes), (size_t)CFDataGetLength(bytes), hash, 129) &&
    snprintf(requirement, 180, "cdhash H\"%s\"", hash) < 180;
  if (information) CFRelease(information); if (code) CFRelease(code); if (url) CFRelease(url);
  if (close(held)) okay = false; return okay;
}
static void cfg_append(CFMutableArrayRef array, const char *path) {
  CFStringRef value = cfg_string(path); if (!value) _exit(78);
  CFArrayAppendValue(array, value); CFRelease(value);
}
static bool cfg_directory_empty(int fd) {
  int scan = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (scan < 0) return false;
  DIR *directory = fdopendir(scan); if (!directory) { close(scan); return false; }
  bool empty = true;
  for (;;) {
    errno = 0; struct dirent *entry = readdir(directory);
    if (!entry) { if (errno) empty = false; break; }
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) { empty = false; break; }
  }
  if (closedir(directory)) empty = false; return empty;
}
#include "legioncode-native-installer-copy.h"
#include "legioncode-native-installer-principals.h"

static bool cfg_actor_namespace(const char *text, const char *path, uid_t *actor, char home[PATH_MAX], int *namespace) {
  if (!text || !text[0]) return false;
  for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') return false;
  char *end = NULL; errno = 0; unsigned long uid = strtoul(text, &end, 10);
  struct stat console; struct passwd account, *found = NULL; char bytes[16384], canonical[PATH_MAX], expected[PATH_MAX];
  if (errno || !end || *end || uid < 501 || uid >= UINT32_MAX || stat("/dev/console", &console) || console.st_uid != uid ||
      getpwuid_r((uid_t)uid, &account, bytes, sizeof(bytes), &found) || !found || account.pw_uid != uid ||
      !lc_host_absolute(account.pw_dir) || !realpath(account.pw_dir, canonical) || strcmp(canonical, account.pw_dir) ||
      snprintf(expected, sizeof(expected), "%s/Library/Application Support/LegionCode/native-workspace-writers-v1", canonical) >= (int)sizeof(expected) ||
      strcmp(path, expected)) return false;
  int fd = cfg_source_open(path, (uid_t)uid, true); struct stat st;
  bool okay = fd >= 0 && !fstat(fd, &st) && st.st_uid == uid && (st.st_mode & 07777) == 0700;
  if (okay) {
    errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
    if (acl) {
      acl_entry_t entry; errno = 0;
      okay = !acl_valid(acl) && acl_get_entry(acl, ACL_FIRST_ENTRY, &entry) == -1 && errno == EINVAL;
      acl_free(acl);
    } else okay = errno == ENOENT;
  }
  if (!okay) { if (fd >= 0) close(fd); return false; }
  *actor = (uid_t)uid; strcpy(home, canonical); *namespace = fd; return true;
}
static bool cfg_namespace_current(const char *path, int fd, uid_t actor, const struct stat *original) {
  struct stat held, named; char uid[16], home[PATH_MAX]; uid_t current_actor = 0; int current = -1;
  snprintf(uid, sizeof(uid), "%u", actor);
  bool okay = cfg_actor_namespace(uid, path, &current_actor, home, &current) && current_actor == actor &&
    !fstat(fd, &held) && !fstat(current, &named) && held.st_dev == original->st_dev && held.st_ino == original->st_ino &&
    named.st_dev == held.st_dev && named.st_ino == held.st_ino;
  if (current >= 0 && close(current)) okay = false; return okay;
}
/* This is the canonical recipe byte format, not CFDictionary serialization.
 * UTF-8 paths are escaped exactly as JSON.stringify strings; array order is policy. */
static bool cfg_json_bytes(char *output, size_t capacity, size_t *length, const char *bytes) {
  size_t size = strlen(bytes); if (size >= capacity - *length) return false;
  memcpy(output + *length, bytes, size); *length += size; output[*length] = 0; return true;
}
static bool cfg_json_path(char *output, size_t capacity, size_t *length, CFStringRef path) {
  char value[PATH_MAX]; if (!lc_host_text(path, value, sizeof(value)) || !cfg_json_bytes(output, capacity, length, "\"")) return false;
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    char escaped[7] = { 0 };
    if (*p == '"' || *p == '\\') { escaped[0] = '\\'; escaped[1] = (char)*p; }
    else if (*p == '\b') strcpy(escaped, "\\b");
    else if (*p == '\f') strcpy(escaped, "\\f");
    else if (*p == '\n') strcpy(escaped, "\\n");
    else if (*p == '\r') strcpy(escaped, "\\r");
    else if (*p == '\t') strcpy(escaped, "\\t");
    else if (*p < 32) snprintf(escaped, sizeof(escaped), "\\u%04x", *p);
    else escaped[0] = (char)*p;
    if (!cfg_json_bytes(output, capacity, length, escaped)) return false;
  }
  return cfg_json_bytes(output, capacity, length, "\"");
}
static bool cfg_policy_digest(CFArrayRef reads, CFArrayRef executables, CFArrayRef protected, char digest[65]) {
  char bytes[32768]; size_t length = 0;
  bool okay = cfg_json_bytes(bytes, sizeof(bytes), &length,
    "{\"domain\":\"LegionCode/native-host/sandbox-policy/v1\",\"recipeVersion\":1");
  CFArrayRef arrays[] = { reads, executables, protected };
  const char *keys[] = { ",\"ReadRoots\":[", ",\"Executables\":[", ",\"ProtectedRoots\":[" };
  for (size_t i = 0; okay && i < 3; i++) {
    okay = cfg_json_bytes(bytes, sizeof(bytes), &length, keys[i]);
    for (CFIndex j = 0; okay && j < CFArrayGetCount(arrays[i]); j++)
      okay = (!j || cfg_json_bytes(bytes, sizeof(bytes), &length, ",")) &&
        cfg_json_path(bytes, sizeof(bytes), &length, CFArrayGetValueAtIndex(arrays[i], j));
    okay = okay && cfg_json_bytes(bytes, sizeof(bytes), &length, "]");
  }
  okay = okay && cfg_json_bytes(bytes, sizeof(bytes), &length, "}");
  if (okay) { unsigned char hash[32]; CC_SHA256(bytes, (CC_LONG)length, hash); lc_host_hex(hash, 32, digest, 65); }
  return okay;
}
static bool cfg_installed_helpers(void) {
  return install_same_bytes(LC_HOST_INSTALLED_BROKER, LC_INSTALL_APP "/Contents/Resources/native/legioncode-host-broker") &&
    install_same_bytes(LC_INSTALL_SELF, LC_INSTALL_APP "/Contents/Resources/native/legioncode-native-installer");
}
static CFMutableDictionaryRef cfg_manifest(uid_t actor, const char *home, const char *namespace_path,
    const struct stat *namespace, CFArrayRef principals, const char *permit) {
  CFMutableDictionaryRef manifest = cfg_dictionary(), resources = cfg_dictionary(), setup = cfg_dictionary(), toolchain = cfg_dictionary(), core = cfg_dictionary();
  CFMutableArrayRef reads = cfg_array(), executables = cfg_array(), protected = cfg_array();
  bool okay = manifest && resources && setup && toolchain && core && reads && executables && protected;
  char bridge[PATH_MAX], digest[65], cdhash[129], requirement[180], kernel[256]; size_t kernel_size = sizeof(kernel);
  snprintf(bridge, sizeof(bridge), "%s/Contents/Resources/native/legioncode-host-broker", LC_INSTALL_APP);
  if (okay) {
    cfg_put_number(manifest, CFSTR("Version"), 1); cfg_put_number(manifest, CFSTR("ActorUID"), actor);
    cfg_put_string(manifest, CFSTR("BundlePath"), LC_INSTALL_APP); cfg_put_string(manifest, CFSTR("BridgePath"), bridge);
    okay = cfg_code_identity(LC_INSTALL_APP, true, cdhash, requirement);
    if (okay) { cfg_put_string(manifest, CFSTR("BundleCDHash"), cdhash); cfg_put_string(manifest, CFSTR("BundleRequirement"), requirement); }
    okay = okay && cfg_code_identity(bridge, false, cdhash, requirement);
    if (okay) { cfg_put_string(manifest, CFSTR("BridgeCDHash"), cdhash); cfg_put_string(manifest, CFSTR("BridgeRequirement"), requirement); }
    okay = okay && cfg_sha_path(LC_HOST_INSTALLED_BROKER, digest);
    if (okay) cfg_put_string(manifest, CFSTR("BrokerSHA256"), digest);
  }
  const char *files[] = { "Contents/Resources/app.asar", "Contents/Resources/native/legioncode-fs-helper",
    "Contents/Resources/native/legioncode-process-helper", "Contents/Resources/native/legioncode-host-broker", "Contents/Resources/native/legioncode-native-installer" };
  for (size_t i = 0; okay && i < sizeof(files) / sizeof(files[0]); i++) {
    char path[PATH_MAX]; CFStringRef key = cfg_string(files[i]);
    okay = key && snprintf(path, sizeof(path), "%s/%s", LC_INSTALL_APP, files[i]) < (int)sizeof(path) && cfg_sha_path(path, digest);
    if (okay) cfg_put_string(resources, key, digest);
    if (okay && i == 1) { okay = cfg_code_identity(path, false, cdhash, requirement); if (okay) cfg_put_string(manifest, CFSTR("FilesystemHelperCDHash"), cdhash); }
    if (key) CFRelease(key);
  }
  if (okay) {
    cfg_put_number(toolchain, CFSTR("RecipeVersion"), 2);
    cfg_put_string(toolchain, CFSTR("NodePath"), LC_INSTALL_TOOLCHAIN "/node");
    okay = cfg_sha_path(LC_INSTALL_TOOLCHAIN "/node", digest) && cfg_code_identity(LC_INSTALL_TOOLCHAIN "/node", false, cdhash, requirement);
    if (okay) { cfg_put_string(toolchain, CFSTR("NodeSHA256"), digest); cfg_put_string(toolchain, CFSTR("NodeCDHash"), cdhash); }
    okay = okay && cfg_sha_path("/bin/bash", digest);
    if (okay) cfg_put_string(toolchain, CFSTR("BashSHA256"), digest);
    cfg_put_string(toolchain, CFSTR("NpmCliPath"), LC_INSTALL_TOOLCHAIN "/npm/bin/npm-cli.js");
    okay = okay && cfg_sha_path(LC_INSTALL_TOOLCHAIN "/npm/bin/npm-cli.js", digest);
    if (okay) cfg_put_string(toolchain, CFSTR("NpmCliSHA256"), digest);
    cfg_put_string(toolchain, CFSTR("NpmLauncherPath"), LC_INSTALL_TOOLCHAIN "/bin/npm");
    okay = okay && cfg_sha_path(LC_INSTALL_TOOLCHAIN "/bin/npm", digest);
    if (okay) cfg_put_string(toolchain, CFSTR("NpmLauncherSHA256"), digest);
    okay = okay && cfg_sha_path("/usr/bin/env", digest) && cfg_code_identity("/usr/bin/env", false, cdhash, requirement);
    if (okay) {
      cfg_put_string(toolchain, CFSTR("EnvSHA256"), digest);
      cfg_put_string(toolchain, CFSTR("EnvCDHash"), cdhash);
    }
    cfg_put_number(setup, CFSTR("Version"), 2); cfg_put_string(setup, CFSTR("PermitId"), permit);
    cfg_put_string(setup, CFSTR("WriterNamespacePath"), namespace_path);
    cfg_put_number(setup, CFSTR("WriterNamespaceDevice"), namespace->st_dev); cfg_put_number(setup, CFSTR("WriterNamespaceInode"), namespace->st_ino);
    CFDictionarySetValue(setup, CFSTR("QualificationToolchain"), toolchain);
    cfg_append(reads, LC_INSTALL_TOOLCHAIN); cfg_append(reads, "/System/Library"); cfg_append(reads, "/usr/lib"); cfg_append(reads, "/bin");
    cfg_append(reads, "/usr/bin/env");
    cfg_append(executables, "/bin/bash"); cfg_append(executables, LC_INSTALL_TOOLCHAIN "/node");
    cfg_append(executables, LC_INSTALL_TOOLCHAIN "/bin/npm"); cfg_append(executables, "/usr/bin/env");
    const char *core_paths[] = { "/bin/sh", "/bin/ls", "/bin/cat", "/bin/cp", "/bin/mkdir", "/bin/rm", "/bin/mv" };
    for (size_t i = 0; okay && i < sizeof(core_paths) / sizeof(core_paths[0]); i++) {
      CFMutableDictionaryRef entry = cfg_dictionary(); CFStringRef path = cfg_string(core_paths[i]);
      okay = entry && path && cfg_sha_path(core_paths[i], digest) &&
        cfg_code_identity(core_paths[i], false, cdhash, requirement);
      if (okay) {
        cfg_put_string(entry, CFSTR("SHA256"), digest); cfg_put_string(entry, CFSTR("CDHash"), cdhash);
        CFDictionarySetValue(core, path, entry); cfg_append(executables, core_paths[i]);
      }
      if (path) CFRelease(path); if (entry) CFRelease(entry);
    }
    char library[PATH_MAX];
    int library_length = snprintf(library, sizeof(library), "%s/Library", home);
    okay = okay && library_length > 0 && library_length < (int)sizeof(library);
    cfg_append(protected, library); cfg_append(protected, LC_INSTALL_APP); cfg_append(protected, "/Library/Keychains");
    okay = okay && cfg_policy_digest(reads, executables, protected, digest);
    if (okay) cfg_put_string(manifest, CFSTR("PolicySHA256"), digest);
    unsigned char random[32]; arc4random_buf(random, sizeof(random)); lc_host_hex(random, 32, digest, 65);
    cfg_put_string(manifest, CFSTR("PolicyGeneration"), digest);
    okay = okay && !sysctlbyname("kern.osrelease", kernel, &kernel_size, NULL, 0) && kernel_size > 0 && kernel_size <= sizeof(kernel) && memchr(kernel, 0, kernel_size);
    if (okay) cfg_put_string(manifest, CFSTR("KernelRelease"), kernel);
    CFDictionarySetValue(manifest, CFSTR("ResourceSHA256"), resources); CFDictionarySetValue(manifest, CFSTR("Principals"), principals);
    CFDictionarySetValue(manifest, CFSTR("CoreExecutables"), core);
    CFDictionarySetValue(manifest, CFSTR("ReadRoots"), reads); CFDictionarySetValue(manifest, CFSTR("Executables"), executables);
    CFDictionarySetValue(manifest, CFSTR("ProtectedRoots"), protected); CFDictionarySetValue(manifest, CFSTR("SetupAuthorization"), setup);
  }
  if (resources) CFRelease(resources); if (setup) CFRelease(setup); if (toolchain) CFRelease(toolchain); if (core) CFRelease(core);
  if (reads) CFRelease(reads); if (executables) CFRelease(executables); if (protected) CFRelease(protected);
  if (!okay) { if (manifest) CFRelease(manifest); return NULL; } return manifest;
}

static bool cfg_selected_node_valid(const char *path, int fd, uid_t actor, lc_install_copy_budget *budget) {
  struct stat before, after, named;
  if (fstat(fd, &before) || !S_ISREG(before.st_mode) || before.st_nlink != 1 || before.st_size <= 0 ||
      before.st_size > 256U * 1024U * 1024U || !(before.st_mode & 0111) ||
      !cfg_readable(&before, actor, false) || !cfg_source_acl(fd, false) || !install_node_dependencies(fd)) return false;
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const unsigned char *)path, strlen(path), false);
  SecStaticCodeRef code = NULL;
  bool okay = url && SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess &&
    SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures, NULL) == errSecSuccess &&
    !fstat(fd, &after) && cfg_same_source(&before, &after) && !lstat(path, &named) && cfg_same_source(&before, &named);
  if (code) CFRelease(code); if (url) CFRelease(url);
  if (okay) { budget->entries = 1; budget->bytes = (uint64_t)before.st_size; } return okay;
}

/* CLI: --configure ACTOR_UID NAMESPACE NODE_SOURCE NPM_DIRECTORY (argc == 6).
 * Explicit OS authorization belongs to Main/Installer, never this function. */
static int install_configure(const char *actor_uid, const char *namespace_path, const char *node_source, const char *npm_source) {
  uid_t actor = 0; char home[PATH_MAX]; int namespace = -1, state = -1, resources = -1, node = -1, npm = -1, toolchain = -1, npm_output = -1;
  struct stat namespace_identity; CFArrayRef principals = NULL; CFMutableDictionaryRef manifest = NULL;
  bool okay = !getuid() && !geteuid() && install_application_valid() && cfg_installed_helpers() && install_absent(LC_HOST_APPROVAL) &&
    install_absent(LC_INSTALL_DIRECTORY "/configure.pending") && install_absent(LC_INSTALL_DIRECTORY "/configure.staged") &&
    install_absent(LC_INSTALL_TOOLCHAIN) && cfg_actor_namespace(actor_uid, namespace_path, &actor, home, &namespace) && !fstat(namespace, &namespace_identity);
  if (okay) {
    state = lc_host_open_protected(LC_INSTALL_DIRECTORY, true); resources = lc_host_open_protected(LC_HOST_STATE, true);
    int staged = lc_host_open_protected(LC_INSTALL_DIRECTORY "/install.staged", false);
    okay = state >= 0 && resources >= 0 && staged >= 0 && cfg_directory_empty(resources);
    if (staged >= 0 && close(staged)) okay = false;
  }
  if (okay) { node = cfg_source_open(node_source, actor, false); npm = cfg_source_open(npm_source, actor, true); okay = node >= 0 && npm >= 0; }
  lc_install_copy_budget preflight = { actor, 0, 0 };
  if (okay) okay = cfg_selected_node_valid(node_source, node, actor, &preflight) &&
    cfg_validate_tree(npm, &preflight) && cfg_npm_package(npm, actor);
  static const char pending[] = "LegionCode native configure v1: pending; execution unqualified\n";
  if (okay) okay = install_write(state, "configure.pending", pending, sizeof(pending) - 1, 0600);
  if (okay) { toolchain = install_directory(state, "toolchain", 0755); okay = toolchain >= 0; }
  lc_install_copy_budget budget = { actor, 0, 0 };
  if (okay) okay = cfg_copy_file(node, toolchain, "node", &budget, 256U * 1024U * 1024U);
  if (okay) { npm_output = install_directory(toolchain, "npm", 0755); okay = npm_output >= 0 && cfg_copy_tree(npm, npm_output, &budget) && cfg_npm_package(npm_output, actor); }
  if (okay) okay = cfg_install_npm_launcher(toolchain);
  char copied_hash[129], copied_requirement[180];
  if (okay) {
    int copied_node = lc_host_open_protected(LC_INSTALL_TOOLCHAIN "/node", false); struct stat copied;
    okay = copied_node >= 0 && !fstat(copied_node, &copied) && copied.st_size > 0 && (copied.st_mode & 0555) == 0555 && install_node_dependencies(copied_node) &&
      cfg_code_identity(LC_INSTALL_TOOLCHAIN "/node", false, copied_hash, copied_requirement);
    if (copied_node >= 0 && close(copied_node)) okay = false;
  }
  unsigned char random[32]; char permit[65]; arc4random_buf(random, sizeof(random)); lc_host_hex(random, 32, permit, sizeof(permit));
  if (okay) { principals = cfg_create_principals(state, actor, permit); okay = principals != NULL; }
  if (okay) { manifest = cfg_manifest(actor, home, namespace_path, &namespace_identity, principals, permit); okay = manifest != NULL; }
  if (okay) okay = cfg_directory_empty(resources) && cfg_namespace_current(namespace_path, namespace, actor, &namespace_identity) &&
    install_application_valid() && cfg_installed_helpers() && cfg_write_plist(state, "approval.plist", manifest);
  if (okay) {
    lc_host_approval approved;
    /* The canonical Version 2 parser/qualification owner must join separately.
     * Never weaken it, fall back to Version 1, or fabricate a qualified flag. */
    okay = lc_host_load_approval(&approved);
    if (okay) okay = !renameatx_np(state, "configure.pending", state, "configure.staged", RENAME_EXCL) && lc_host_sync(state);
  }
  if (manifest) CFRelease(manifest); if (principals) CFRelease(principals);
  int fds[] = { npm_output, toolchain, npm, node, resources, state, namespace };
  for (size_t i = 0; i < sizeof(fds) / sizeof(fds[0]); i++) if (fds[i] >= 0 && close(fds[i])) okay = false;
  /* Only the successful ORIGINAL authorized invocation hands the permit to Main.
   * A lost response never authorizes another configure or qualification start. */
  if (okay) {
    char receipt[96];
    int length = snprintf(receipt, sizeof(receipt), "LC_NATIVE_SETUP_V1:%s\n", permit);
    okay = length > 0 && length < (int)sizeof(receipt) && lc_host_io(STDOUT_FILENO, receipt, (size_t)length, true);
  }
  return okay ? 0 : 78;
}
#endif
