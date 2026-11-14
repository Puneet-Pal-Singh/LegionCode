#ifndef LEGIONCODE_HOST_SETUP_IMAGE_H
#define LEGIONCODE_HOST_SETUP_IMAGE_H
#include "legioncode-host-scope.h"

#define LC_HOST_SETUP_FILESYSTEM_HELPER "Contents/Resources/native/legioncode-fs-helper"
#define LC_HOST_SETUP_IMAGE_ANCESTORS 8U
#define LC_HOST_SETUP_IMAGE_MAX_BYTES (64U * 1024U * 1024U)
typedef struct {
  bool started, created, sealed, unlinked, source_closed, write_closed, file_closed, closed;
  int source_fd, write_fd, file_fd;
  /* Original numbers remain diagnostic only after an uncertain close; never
   * treat a reused number as authority to retry that original close. */
  int original_source_fd, original_write_fd, original_file_fd;
  int ancestor[LC_HOST_SETUP_IMAGE_ANCESTORS], original_ancestor[LC_HOST_SETUP_IMAGE_ANCESTORS];
  lc_host_file_identity ancestor_identity[LC_HOST_SETUP_IMAGE_ANCESTORS], file_identity;
  char component[LC_HOST_SETUP_IMAGE_ANCESTORS][NAME_MAX + 1];
  size_t ancestor_count; uint64_t bytes;
  char name[180], path[PATH_MAX]; unsigned char sha256[32];
} lc_host_setup_image;

static inline bool lc_host_setup_image_signature(const lc_host_approval *approval, const char *path) {
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const unsigned char *)path, (CFIndex)strlen(path), false);
  SecStaticCodeRef code = NULL; bool okay = url && SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess;
  if (url) CFRelease(url);
  okay = okay && SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures, NULL) == errSecSuccess &&
    lc_host_code_hash(code, CFDictionaryGetValue(approval->manifest, CFSTR("FilesystemHelperCDHash")));
  if (code) CFRelease(code); return okay;
}
static inline bool lc_host_setup_image_ancestors(const lc_host_setup_image *image) {
  if (!image->ancestor_count || image->ancestor_count > LC_HOST_SETUP_IMAGE_ANCESTORS) return false;
  for (size_t i = 0; i < image->ancestor_count; i++) {
    struct stat held, named;
    if (image->ancestor[i] < 0 || fstat(image->ancestor[i], &held) || !lc_host_protected_fd(image->ancestor[i], true) ||
        !(held.st_mode & S_IXOTH) || (uint64_t)held.st_dev != image->ancestor_identity[i].device ||
        (uint64_t)held.st_ino != image->ancestor_identity[i].inode) return false;
    if (i && (fstatat(image->ancestor[i - 1], image->component[i], &named, AT_SYMLINK_NOFOLLOW) ||
        !S_ISDIR(named.st_mode) || named.st_dev != held.st_dev || named.st_ino != held.st_ino)) return false;
  }
  return true;
}
static inline bool lc_host_setup_image_current(const lc_host_approval *approval, const lc_host_setup_image *image) {
  struct stat held, named;
  if (!image->sealed || image->unlinked || !image->source_closed || !image->write_closed || image->file_fd < 0 ||
      !lc_host_setup_image_ancestors(image) || fstat(image->file_fd, &held) || !S_ISREG(held.st_mode) || held.st_uid ||
      (held.st_mode & 07777) != 0555 || held.st_nlink != 1 || (uint64_t)held.st_size != image->bytes ||
      (uint64_t)held.st_dev != image->file_identity.device || (uint64_t)held.st_ino != image->file_identity.inode ||
      !lc_host_protected_acl(image->file_fd) ||
      fstatat(image->ancestor[image->ancestor_count - 1], image->name, &named, AT_SYMLINK_NOFOLLOW) ||
      !S_ISREG(named.st_mode) || named.st_dev != held.st_dev || named.st_ino != held.st_ino) return false;
  int flags = fcntl(image->file_fd, F_GETFL); char digest[65];
  lc_host_hex(image->sha256, sizeof(image->sha256), digest, sizeof(digest));
  return flags >= 0 && (flags & O_ACCMODE) == O_RDONLY &&
    lc_host_sha_file(image->path, digest) && lc_host_setup_image_signature(approval, image->path);
}
static inline bool lc_host_setup_image_create(const lc_host_approval *approval, const lc_host_writer_binding *binding,
    lc_host_setup_image *image) {
  if (getuid() || geteuid() || image->started) return false;
  image->started = true; image->source_fd = image->write_fd = image->file_fd = -1;
  image->original_source_fd = image->original_write_fd = image->original_file_fd = -1;
  for (size_t i = 0; i < LC_HOST_SETUP_IMAGE_ANCESTORS; i++) image->ancestor[i] = image->original_ancestor[i] = -1;
  char work[PATH_MAX]; strcpy(work, LC_HOST_WORK);
  int root = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (root < 0) return false;
  image->ancestor[0] = image->original_ancestor[0] = root; image->ancestor_count = 1;
  if (!lc_host_identity(root, true, &image->ancestor_identity[0])) return false;
  char *save = NULL, *part = strtok_r(work + 1, "/", &save);
  while (part) {
    if (!lc_host_setup_image_ancestors(image) || image->ancestor_count == LC_HOST_SETUP_IMAGE_ANCESTORS ||
        !strcmp(part, ".") || !strcmp(part, "..") || strlen(part) > NAME_MAX) return false;
    size_t index = image->ancestor_count;
    int fd = openat(image->ancestor[index - 1], part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return false;
    image->ancestor[index] = image->original_ancestor[index] = fd; image->ancestor_count++;
    strcpy(image->component[index], part);
    if (!lc_host_identity(fd, true, &image->ancestor_identity[index])) return false;
    part = strtok_r(NULL, "/", &save);
  }
  /* Installer-owned traversal is a prerequisite. Never chmod/add an ACL to a
   * protected parent merely to make setup run; 0700 fails before execution. */
  if (!lc_host_setup_image_ancestors(image)) return false;
  char resource[65], generation[65];
  lc_host_hex(binding->resource_id, 32, resource, sizeof(resource));
  lc_host_hex(binding->broker_resource_generation, 32, generation, sizeof(generation));
  if (snprintf(image->name, sizeof(image->name), "metadata.%s.%s.helper", resource, generation) >= (int)sizeof(image->name) ||
      snprintf(image->path, sizeof(image->path), "%s/%s", LC_HOST_WORK, image->name) >= (int)sizeof(image->path)) return false;
  CFTypeRef raw = CFDictionaryGetValue(approval->manifest, CFSTR("ResourceSHA256"));
  char expected[65], source[PATH_MAX]; unsigned char expected_bytes[32];
  if (!raw || CFGetTypeID(raw) != CFDictionaryGetTypeID() ||
      !lc_host_text(CFDictionaryGetValue(raw, CFSTR(LC_HOST_SETUP_FILESYSTEM_HELPER)), expected, sizeof(expected)) ||
      !lc_host_unhex(expected, expected_bytes, 32) ||
      snprintf(source, sizeof(source), "%s/%s", approval->bundle, LC_HOST_SETUP_FILESYSTEM_HELPER) >= (int)sizeof(source)) return false;
  image->source_fd = image->original_source_fd = open(source, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat original;
  if (image->source_fd < 0 || fstat(image->source_fd, &original) || !S_ISREG(original.st_mode) ||
      (original.st_uid != 0 && original.st_uid != approval->actor) || original.st_size <= 0 || original.st_size > LC_HOST_SETUP_IMAGE_MAX_BYTES) return false;
  image->write_fd = image->original_write_fd = openat(image->ancestor[image->ancestor_count - 1], image->name,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (image->write_fd < 0) return false;
  image->created = true; CC_SHA256_CTX hash; CC_SHA256_Init(&hash);
  for (;;) {
    unsigned char buffer[32768]; ssize_t count = read(image->source_fd, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return false;
    if (!count) break;
    if ((uint64_t)count > LC_HOST_SETUP_IMAGE_MAX_BYTES - image->bytes || !lc_host_io(image->write_fd, buffer, (size_t)count, true)) return false;
    CC_SHA256_Update(&hash, buffer, (CC_LONG)count); image->bytes += (uint64_t)count;
  }
  CC_SHA256_Final(image->sha256, &hash);
  if (!image->bytes || memcmp(image->sha256, expected_bytes, 32) || !lc_host_identity(image->write_fd, false, &image->file_identity) ||
      !lc_host_protected_fd(image->write_fd, false) || !lc_host_sync(image->write_fd)) return false;
  int original_fd = image->source_fd; image->source_fd = -1;
  if (close(original_fd)) return false;
  image->source_closed = true;
  if (fchmod(image->write_fd, 0555) || !lc_host_sync(image->write_fd)) return false;
  original_fd = image->write_fd; image->write_fd = -1;
  if (close(original_fd)) return false;
  image->write_closed = true;
  image->file_fd = image->original_file_fd = openat(image->ancestor[image->ancestor_count - 1], image->name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (image->file_fd < 0 || !lc_host_sync(image->ancestor[image->ancestor_count - 1])) return false;
  image->sealed = true; return lc_host_setup_image_current(approval, image);
}
static inline bool lc_host_setup_image_remove(const lc_host_approval *approval, lc_host_setup_image *image) {
  if (!lc_host_setup_image_current(approval, image)) return false;
  if (unlinkat(image->ancestor[image->ancestor_count - 1], image->name, 0)) return false;
  image->unlinked = true;
  if (!lc_host_sync(image->ancestor[image->ancestor_count - 1])) return false;
  int original = image->file_fd; image->file_fd = -1;
  if (close(original)) return false;
  image->file_closed = true;
  for (size_t i = image->ancestor_count; i > 0; i--) {
    original = image->ancestor[i - 1]; image->ancestor[i - 1] = -1;
    if (close(original)) return false;
  }
  image->closed = true; return true;
}
#endif
