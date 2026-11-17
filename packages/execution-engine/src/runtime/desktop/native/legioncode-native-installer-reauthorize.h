#ifndef LEGIONCODE_NATIVE_INSTALLER_REAUTHORIZE_H
#define LEGIONCODE_NATIVE_INSTALLER_REAUTHORIZE_H
#include "legioncode-host-principal.h"
#include "legioncode-host-qualification-toolchain.h"

/* No history scan, reconciliation or resource release lives in the installer.
 * Only the canonical broker's fully retired READY deny seal permits rotation. */
static bool reauthorize_named(int fd, const char *path, const struct stat *original) {
  struct stat held, named;
  return !fstat(fd, &held) && !lstat(path, &named) && cfg_same_source(original, &held) &&
    cfg_same_source(&held, &named) && S_ISREG(held.st_mode) && held.st_uid == 0 && held.st_nlink == 1 &&
    (held.st_mode & 07777) == 0600 && lc_host_protected_fd(fd, false);
}
static bool reauthorize_digest(int fd, const struct stat *original, const unsigned char expected[32]) {
  if (original->st_size <= 0 || original->st_size > 65536) return false;
  CC_SHA256_CTX hash; CC_SHA256_Init(&hash); off_t offset = 0;
  while (offset < original->st_size) {
    unsigned char bytes[8192]; size_t wanted = sizeof(bytes);
    if ((off_t)wanted > original->st_size - offset) wanted = (size_t)(original->st_size - offset);
    ssize_t count = pread(fd, bytes, wanted, offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    CC_SHA256_Update(&hash, bytes, (CC_LONG)count); offset += count;
  }
  unsigned char digest[32]; struct stat current; CC_SHA256_Final(digest, &hash);
  return !memcmp(digest, expected, 32) && !fstat(fd, &current) && cfg_same_source(original, &current);
}
static bool reauthorize_directory(int fd, const char *path) {
  struct stat held, named;
  return !fstat(fd, &held) && !lstat(path, &named) && S_ISDIR(named.st_mode) &&
    held.st_dev == named.st_dev && held.st_ino == named.st_ino && lc_host_protected_fd(fd, true);
}
static bool reauthorize_seal(const lc_host_approval *approval, lc_host_reauthorization_seal *seal) {
  bool present = false;
  return lc_host_reauthorization_seal_read(approval, approval->manifest_sha256, seal, &present) &&
    present && seal->phase == LC_HOST_REAUTHORIZATION_READY;
}
static void reauthorize_release_approval(lc_host_approval *approval) {
  if (approval->bundle_requirement) CFRelease(approval->bundle_requirement);
  if (approval->bridge_requirement) CFRelease(approval->bridge_requirement);
  if (approval->manifest) CFRelease(approval->manifest);
}
static bool reauthorize_close_tools(lc_host_qualification_toolchain *tools) {
  bool okay = lc_host_qualification_toolchain_close(tools);
  /* The canonical closer stops on uncertainty. Still attempt every remaining
   * original FD, without retrying a consumed/uncertain descriptor number. */
  for (size_t i = 0; i < LC_HOST_TOOLCHAIN_ROLES; i++) {
    int original = tools->fd[i]; tools->fd[i] = -1;
    if (original >= 0) { if (close(original)) okay = false; else tools->closed[i] = true; }
  }
  return okay;
}
static bool reauthorize_principals(const lc_host_approval *approval) {
  for (size_t i = 0; i < approval->principal_count; i++)
    if (!lc_host_principal_valid(&approval->principals[i])) return false;
  return approval->principal_count != 0;
}

static int install_reauthorize(const char *actor_uid, const char *namespace_path, const char *expected_sha) {
  uid_t actor = 0; char home[PATH_MAX], permit[65], published_sha[65];
  unsigned char expected[32], random[32], published_digest[32];
  int namespace = -1, state = -1, resources = -1, approval_fd = -1, next_fd = -1;
  struct stat namespace_identity, approval_identity, next_identity;
  lc_host_approval original = {0}, published = {0};
  lc_host_reauthorization_seal seal, current_seal;
  lc_host_qualification_toolchain tools; memset(&tools, 0, sizeof(tools));
  for (size_t i = 0; i < LC_HOST_TOOLCHAIN_ROLES; i++) tools.fd[i] = -1;
  bool tools_started = false;
  CFMutableDictionaryRef manifest = NULL, setup = NULL; CFDataRef serialized = NULL;
  bool okay = !getuid() && !geteuid() && lc_host_unhex(expected_sha, expected, sizeof(expected)) &&
    install_application_valid() && cfg_installed_helpers() &&
    install_absent(LC_INSTALL_DIRECTORY "/configure.pending") &&
    install_absent(LC_INSTALL_DIRECTORY "/approval.next") &&
    cfg_actor_namespace(actor_uid, namespace_path, &actor, home, &namespace) && !fstat(namespace, &namespace_identity);
  if (okay) {
    state = lc_host_open_protected(LC_INSTALL_DIRECTORY, true);
    resources = lc_host_open_protected(LC_HOST_STATE, true);
    int staged = lc_host_open_protected(LC_INSTALL_DIRECTORY "/configure.staged", false);
    okay = state >= 0 && resources >= 0 && staged >= 0;
    if (staged >= 0 && close(staged)) okay = false;
  }
  if (okay) {
    approval_fd = lc_host_open_protected(LC_HOST_APPROVAL, false);
    okay = approval_fd >= 0 && !flock(approval_fd, LOCK_EX | LOCK_NB) &&
      !fstat(approval_fd, &approval_identity) && reauthorize_named(approval_fd, LC_HOST_APPROVAL, &approval_identity) &&
      reauthorize_digest(approval_fd, &approval_identity, expected) && lc_host_load_approval(&original) &&
      !memcmp(original.manifest_sha256, expected, 32) && original.actor == actor && original.platform_matches &&
      original.setup_authorized && original.reauthorization_sealed && !strcmp(original.bundle, LC_INSTALL_APP) &&
      !strcmp(original.bridge, LC_INSTALL_APP "/Contents/Resources/native/legioncode-host-broker") &&
      !strcmp(original.writer_namespace_path, namespace_path) &&
      original.writer_namespace.device == (uint64_t)namespace_identity.st_dev &&
      original.writer_namespace.inode == (uint64_t)namespace_identity.st_ino &&
      lc_host_installed_broker_valid(&original) && reauthorize_seal(&original, &seal) && reauthorize_principals(&original);
  }
  if (okay) { tools_started = true; okay = lc_host_qualification_toolchain_open(&original, &tools); }
  if (okay) {
    CFTypeRef old_setup = CFDictionaryGetValue(original.manifest, CFSTR("SetupAuthorization"));
    okay = old_setup && CFGetTypeID(old_setup) == CFDictionaryGetTypeID();
    if (okay) {
      manifest = CFDictionaryCreateMutableCopy(NULL, 0, original.manifest);
      setup = CFDictionaryCreateMutableCopy(NULL, 0, old_setup);
      okay = manifest && setup;
    }
  }
  if (okay) {
    do { arc4random_buf(random, sizeof(random)); } while (!lc_host_nonzero(random, sizeof(random)));
    okay = lc_host_hex(random, sizeof(random), permit, sizeof(permit)) && strcmp(permit, original.setup_permit_id);
    if (okay) {
      cfg_put_string(setup, CFSTR("PermitId"), permit);
      CFDictionarySetValue(manifest, CFSTR("SetupAuthorization"), setup);
      serialized = CFPropertyListCreateData(NULL, manifest, kCFPropertyListXMLFormat_v1_0, 0, NULL);
      okay = serialized && CFDataGetLength(serialized) > 0 && CFDataGetLength(serialized) <= 65536;
    }
  }
  if (okay) {
    CC_SHA256(CFDataGetBytePtr(serialized), (CC_LONG)CFDataGetLength(serialized), published_digest);
    okay = memcmp(published_digest, expected, 32) != 0 && lc_host_hex(published_digest, 32, published_sha, sizeof(published_sha));
    if (okay) next_fd = openat(state, "approval.next", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    okay = okay && next_fd >= 0 && !flock(next_fd, LOCK_EX | LOCK_NB);
    if (okay) {
      acl_t empty = acl_init(0);
      okay = empty && !acl_set_fd_np(next_fd, empty, ACL_TYPE_EXTENDED);
      if (empty) acl_free(empty);
      okay = okay && !fchmod(next_fd, 0600) && lc_host_protected_fd(next_fd, false) &&
        lc_host_io(next_fd, (void *)CFDataGetBytePtr(serialized), (size_t)CFDataGetLength(serialized), true) &&
        lc_host_sync(next_fd) && lc_host_sync(state) && !fstat(next_fd, &next_identity);
    }
  }
  if (okay) {
    okay = reauthorize_named(approval_fd, LC_HOST_APPROVAL, &approval_identity) &&
      reauthorize_digest(approval_fd, &approval_identity, expected) &&
      reauthorize_named(next_fd, LC_INSTALL_DIRECTORY "/approval.next", &next_identity) &&
      reauthorize_digest(next_fd, &next_identity, published_digest) &&
      reauthorize_directory(state, LC_INSTALL_DIRECTORY) && reauthorize_directory(resources, LC_HOST_STATE) &&
      cfg_namespace_current(namespace_path, namespace, actor, &namespace_identity) &&
      lc_host_reauthorization_load(&original) && original.reauthorization_sealed &&
      reauthorize_seal(&original, &current_seal) && !memcmp(&seal, &current_seal, sizeof(seal)) &&
      lc_host_qualification_toolchain_current(&original, &tools) && reauthorize_principals(&original) &&
      install_application_valid() && cfg_installed_helpers() &&
      install_absent(LC_INSTALL_DIRECTORY "/configure.pending");
  }
  if (okay) okay = !renameat(state, "approval.next", state, "approval.plist") && lc_host_sync(state);
  if (okay) {
    struct stat renamed;
    okay = !fstat(next_fd, &renamed) && renamed.st_dev == next_identity.st_dev && renamed.st_ino == next_identity.st_ino &&
      renamed.st_size == next_identity.st_size && renamed.st_mode == next_identity.st_mode;
    if (okay) next_identity = renamed; /* Our own rename may update inode ctime. */
    okay = okay && reauthorize_named(next_fd, LC_HOST_APPROVAL, &next_identity) &&
      reauthorize_digest(next_fd, &next_identity, published_digest) && lc_host_load_approval(&published) &&
      !memcmp(published.manifest_sha256, published_digest, 32) && memcmp(published.manifest_sha256, expected, 32) &&
      !strcmp(published.setup_permit_id, permit) && CFEqual(published.manifest, manifest) &&
      published.platform_matches && published.setup_authorized && !published.reauthorization_sealed;
  }
  /* launchctl completion confirms only this fixed control operation. It is not
   * broker readiness, qualification, cleanup or execution acceptance evidence. */
  if (okay) okay = install_launchctl(true);
  if (tools_started && !reauthorize_close_tools(&tools)) okay = false;
  reauthorize_release_approval(&published); reauthorize_release_approval(&original);
  if (serialized) CFRelease(serialized); if (setup) CFRelease(setup); if (manifest) CFRelease(manifest);
  int fds[] = { next_fd, approval_fd, resources, state, namespace };
  for (size_t i = 0; i < sizeof(fds) / sizeof(fds[0]); i++) if (fds[i] >= 0 && close(fds[i])) okay = false;
  if (!okay) return 78;
  return printf("LC_NATIVE_REAUTHORIZE_V1:%s:%s\n", permit, published_sha) > 0 && !fflush(stdout) ? 0 : 74;
}
#endif
