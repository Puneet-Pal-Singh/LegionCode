#ifndef LEGIONCODE_HOST_QUALIFICATION_CLEANUP_H
#define LEGIONCODE_HOST_QUALIFICATION_CLEANUP_H
#include "legioncode-host-contract.h"
#include <dirent.h>

/* Disposal of ONLY the service-created qualification roots, after UID zero,
 * original command/pipe closure and canonical U->V. Each traversal description
 * is independent, relative to the retained original root; never a path reopen. */
typedef struct { DIR *directory; lc_host_file_identity identity; char name[NAME_MAX + 1]; } lc_qualification_cleanup_frame;
typedef struct {
  lc_qualification_cleanup_frame frame[18]; size_t depth, count;
  bool started, complete, unknown; uint64_t device; uid_t actor;
} lc_qualification_cleanup;
static inline bool lc_qualification_cleanup_begin(int root, uid_t actor, lc_qualification_cleanup *cleanup) {
  if (cleanup->started) return false;
  memset(cleanup, 0, sizeof(*cleanup)); cleanup->started = true; cleanup->actor = actor;
  int fd = openat(root, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  lc_host_file_identity held;
  if (fd < 0 || !lc_host_identity(root, true, &held) || !lc_host_identity(fd, true, &cleanup->frame[0].identity) ||
      !lc_host_same(held, cleanup->frame[0].identity)) { cleanup->unknown = true; return false; }
  cleanup->device = held.device; cleanup->frame[0].directory = fdopendir(fd);
  if (!cleanup->frame[0].directory) { cleanup->unknown = true; return false; }
  cleanup->depth = 1; return true;
}
static inline bool lc_qualification_cleanup_step(lc_qualification_cleanup *cleanup) {
  if (!cleanup->started || cleanup->unknown) return false;
  if (cleanup->complete) return true;
  lc_qualification_cleanup_frame *frame = &cleanup->frame[cleanup->depth - 1];
  errno = 0; struct dirent *entry = readdir(frame->directory);
  if (!entry) {
    int error = errno; int descriptor = dirfd(frame->directory);
    if (error || !lc_host_sync(descriptor)) { cleanup->unknown = true; return false; }
    if (cleanup->depth > 1) {
      struct stat named; int parent = dirfd(cleanup->frame[cleanup->depth - 2].directory);
      if (fstatat(parent, frame->name, &named, AT_SYMLINK_NOFOLLOW) || !S_ISDIR(named.st_mode) ||
          (uint64_t)named.st_dev != frame->identity.device || (uint64_t)named.st_ino != frame->identity.inode ||
          unlinkat(parent, frame->name, AT_REMOVEDIR)) { cleanup->unknown = true; return false; }
    }
    DIR *original = frame->directory; frame->directory = NULL;
    if (closedir(original)) { cleanup->unknown = true; return false; }
    if (!--cleanup->depth) cleanup->complete = true; return true;
  }
  if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) return true;
  struct stat named; int parent = dirfd(frame->directory);
  if (++cleanup->count > LC_HOST_MAX_ENTRIES || fstatat(parent, entry->d_name, &named, AT_SYMLINK_NOFOLLOW) ||
      (uint64_t)named.st_dev != cleanup->device || (named.st_uid != cleanup->actor && named.st_uid != 0)) {
    cleanup->unknown = true; return false;
  }
  if (S_ISDIR(named.st_mode)) {
    if (cleanup->depth == sizeof(cleanup->frame) / sizeof(cleanup->frame[0])) { cleanup->unknown = true; return false; }
    lc_qualification_cleanup_frame *next = &cleanup->frame[cleanup->depth];
    int fd = openat(parent, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 || !lc_host_identity(fd, true, &next->identity) || next->identity.device != (uint64_t)named.st_dev ||
        next->identity.inode != (uint64_t)named.st_ino) { cleanup->unknown = true; return false; }
    strcpy(next->name, entry->d_name); next->directory = fdopendir(fd);
    if (!next->directory) { cleanup->unknown = true; return false; }
    cleanup->depth++; return true;
  }
  if ((!S_ISREG(named.st_mode) && !S_ISLNK(named.st_mode)) || unlinkat(parent, entry->d_name, 0)) {
    cleanup->unknown = true; return false;
  }
  return true;
}
#endif
