#ifndef LEGIONCODE_HOST_METADATA_H
#define LEGIONCODE_HOST_METADATA_H
#include "legioncode-host-wire.h"

#define LC_HOST_METADATA_FIELDS "metadataIdentity", "storageIdentity", "gitDirectory", "commonDirectory", "backlinkPath", "objectsDirectory", "packDirectory", "infoDirectory", "refsDirectory", "commonLogsDirectory", "worktreeLogsDirectory", "repositoryInfoDirectory"
#define LC_HOST_METADATA_PATHS 10U
typedef struct {
  char identity[513], storage_identity[513], paths[LC_HOST_METADATA_PATHS][PATH_MAX];
  unsigned char digest[32];
} lc_host_metadata;
typedef struct { int fd[LC_HOST_METADATA_PATHS]; bool absent[LC_HOST_METADATA_PATHS]; lc_host_file_identity identity[LC_HOST_METADATA_PATHS]; } lc_host_metadata_pins;

static inline bool lc_host_metadata_path(const char *path) {
  if (path[0] != '/' || !path[1] || strlen(path) > 500 || path[strlen(path) - 1] == '/' ||
      strstr(path, "/../") || strstr(path, "/./") || strstr(path, "//") || strchr(path, '\n') || strchr(path, '\r')) return false;
  char existing[PATH_MAX], canonical[PATH_MAX]; strcpy(existing, path); struct stat st;
  while (lstat(existing, &st)) {
    if (errno != ENOENT) return false;
    char *slash = strrchr(existing, '/'); if (!slash || slash == existing) return false; *slash = 0;
  }
  return !S_ISLNK(st.st_mode) && realpath(existing, canonical) && !strcmp(existing, canonical);
}
static inline bool lc_host_metadata_record_valid(const lc_host_metadata *metadata) {
  if (!memchr(metadata->identity, 0, sizeof(metadata->identity)) || !metadata->identity[0] ||
      !memchr(metadata->storage_identity, 0, sizeof(metadata->storage_identity)) || !metadata->storage_identity[0]) return false;
  static const char *const keys[] = { LC_HOST_METADATA_FIELDS };
  CC_SHA256_CTX digest; unsigned char hash[32]; CC_SHA256_Init(&digest);
  for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
    const char *value = i == 0 ? metadata->identity : i == 1 ? metadata->storage_identity : metadata->paths[i - 2];
    if (i >= 2 && (!memchr(value, 0, PATH_MAX) || (!value[0] && i != 4))) return false;
    CC_SHA256_Update(&digest, keys[i], (CC_LONG)strlen(keys[i]) + 1);
    CC_SHA256_Update(&digest, value, (CC_LONG)strlen(value) + 1);
  }
  CC_SHA256_Final(hash, &digest); return !memcmp(hash, metadata->digest, 32);
}
/* Consume the canonical inspector receipt. This code never interprets .git,
 * commondir, backlinks or Git configuration, and is not another Git parser. */
static inline bool lc_host_metadata_read(xpc_object_t request, lc_host_metadata *metadata) {
  static const char *const keys[] = { LC_HOST_METADATA_FIELDS };
  memset(metadata, 0, sizeof(*metadata)); CC_SHA256_CTX digest; CC_SHA256_Init(&digest);
  for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
    char *out = i == 0 ? metadata->identity : i == 1 ? metadata->storage_identity : metadata->paths[i - 2];
    size_t bound = i < 2 ? 513 : PATH_MAX;
    xpc_object_t value = xpc_dictionary_get_value(request, keys[i]);
    if (i == 4 && value && xpc_get_type(value) == XPC_TYPE_DATA && !xpc_data_get_length(value)) out[0] = 0;
    else if (!lc_host_get(request, keys[i], out, bound)) return false;
    if (i >= 2 && out[0] && !lc_host_metadata_path(out)) return false;
    CC_SHA256_Update(&digest, keys[i], (CC_LONG)strlen(keys[i]) + 1);
    CC_SHA256_Update(&digest, out, (CC_LONG)strlen(out) + 1);
  }
  CC_SHA256_Final(metadata->digest, &digest); return true;
}
static inline bool lc_host_metadata_current(const lc_host_metadata *metadata, const lc_host_metadata_pins *pins) {
  for (size_t i = 0; i < LC_HOST_METADATA_PATHS; i++) {
    if (!metadata->paths[i][0]) continue;
    struct stat held, path;
    if (pins->absent[i]) {
      if (!lstat(metadata->paths[i], &path) || errno != ENOENT || !lc_host_metadata_path(metadata->paths[i])) return false;
      continue;
    }
    if (pins->fd[i] < 0 || fstat(pins->fd[i], &held) || lstat(metadata->paths[i], &path) || S_ISLNK(path.st_mode) ||
        (uint64_t)held.st_dev != pins->identity[i].device || (uint64_t)held.st_ino != pins->identity[i].inode ||
        held.st_dev != path.st_dev || held.st_ino != path.st_ino || (held.st_mode & S_IFMT) != (path.st_mode & S_IFMT)) return false;
  }
  return true;
}
static inline bool lc_host_metadata_open(const lc_host_metadata *metadata, lc_host_metadata_pins *pins, const char *root) {
  char sentinel[PATH_MAX];
  for (size_t i = 0; i < LC_HOST_METADATA_PATHS; i++) { pins->fd[i] = -1; pins->absent[i] = false; }
  if (snprintf(sentinel, sizeof(sentinel), "%s/.git", root) >= (int)sizeof(sentinel) ||
      strcmp(metadata->paths[2][0] ? metadata->paths[2] : metadata->paths[0], sentinel)) return false;
  bool okay = true;
  for (size_t i = 0; okay && i < LC_HOST_METADATA_PATHS; i++) {
    if (!metadata->paths[i][0]) continue;
    if (lc_host_beneath(metadata->paths[i], root)) { okay = false; break; }
    bool directory = i != 2;
    pins->fd[i] = open(metadata->paths[i], O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (directory ? O_DIRECTORY : 0));
    if (pins->fd[i] < 0 && i >= 7 && errno == ENOENT) { pins->absent[i] = true; continue; }
    struct stat st;
    okay = pins->fd[i] >= 0 && !fstat(pins->fd[i], &st) && (directory ? S_ISDIR(st.st_mode) : S_ISREG(st.st_mode)) &&
      lc_host_identity(pins->fd[i], directory, &pins->identity[i]);
  }
  if (okay) okay = lc_host_metadata_current(metadata, pins);
  if (!okay) for (size_t i = 0; i < LC_HOST_METADATA_PATHS; i++) if (pins->fd[i] >= 0) { close(pins->fd[i]); pins->fd[i] = -1; }
  return okay;
}
static inline bool lc_host_metadata_contains(const lc_host_metadata *metadata, const char *path, const struct stat *st,
    const lc_host_metadata_pins *pins) {
  for (size_t i = 0; i < LC_HOST_METADATA_PATHS; i++) if (metadata->paths[i][0] &&
      (lc_host_beneath(metadata->paths[i], path) || (st && !pins->absent[i] && (uint64_t)st->st_dev == pins->identity[i].device &&
        (uint64_t)st->st_ino == pins->identity[i].inode))) return true;
  return false;
}
#endif
