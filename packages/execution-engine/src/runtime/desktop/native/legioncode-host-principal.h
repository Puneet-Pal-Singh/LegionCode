#ifndef LEGIONCODE_HOST_PRINCIPAL_H
#define LEGIONCODE_HOST_PRINCIPAL_H
#include "legioncode-host-approval.h"
#include <grp.h>
#include <sys/resource.h>
#include <stddef.h>
#include <dirent.h>

/* _DARWIN_C_SOURCE redirects getgroups to Directory Services' unlimited
 * variant, which explicitly does not report a preceding setgroups change.
 * Use the documented legacy POSIX entry point for the actual kernel list. */
extern int lc_host_posix_getgroups(int, gid_t []) __asm("_getgroups");
static inline bool lc_host_groups_private(gid_t gid) {
  gid_t groups[NGROUPS_MAX];
  int count = lc_host_posix_getgroups(NGROUPS_MAX, groups);
  if (count < 0 || count > NGROUPS_MAX) return false;
  for (int i = 0; i < count; i++) if (groups[i] != gid) return false;
  return true;
}

/* Scope zero is stronger than a PID list snapshot: after the durable creator
 * gate closes, no trusted bootstrap may enter this never-reused real UID. A
 * successful nonnull one-PID query returning zero has scanned allproc/zombproc.
 * libproc returns zero on error too; errno must be cleared and checked. */
static inline bool lc_host_uid_zero(uid_t uid) {
  pid_t one = -1; errno = 0;
  int bytes = proc_listpids(PROC_RUID_ONLY, uid, &one, sizeof(one));
  return bytes == 0 && errno == 0;
}
static inline bool lc_host_principal_valid(const lc_host_principal *principal) {
  uuid_t current, group_guid; struct passwd value, *found = NULL; char buffer[16384];
  struct group group, *found_group = NULL; char group_buffer[16384]; id_t id; int type;
  if (principal->uid <= 501 || principal->gid <= 501 ||
      getpwuid_r(principal->uid, &value, buffer, sizeof(buffer), &found) || !found ||
      value.pw_uid != principal->uid || value.pw_gid != principal->gid ||
      (strcmp(value.pw_shell, "/usr/bin/false") && strcmp(value.pw_shell, "/usr/bin/nologin")) ||
      mbr_uid_to_uuid(principal->uid, current) || memcmp(current, principal->guid, sizeof(current)) ||
      mbr_uuid_to_id(principal->guid, &id, &type) || type != ID_TYPE_UID || id != principal->uid ||
      getgrgid_r(principal->gid, &group, group_buffer, sizeof(group_buffer), &found_group) || !found_group ||
      group.gr_gid != principal->gid || mbr_gid_to_uuid(principal->gid, group_guid) ||
      mbr_uuid_to_id(group_guid, &id, &type) || type != ID_TYPE_GID || id != principal->gid) return false;
  return lc_host_uid_zero(principal->uid);
}
/* The original resource-ID prefix remains recognizable. The appended binding
 * preserves the attempt association even if the first full scope save fails. */
typedef struct {
  unsigned char resource_id[32];
  uint32_t version, bytes;
  lc_host_writer_binding binding;
  unsigned char digest[32];
} lc_host_reservation;
_Static_assert(sizeof(lc_host_reservation) == 344, "Protected host reservation format");
static inline bool lc_host_reservation_read(int state, const lc_host_approval *approval,
    uid_t uid, lc_host_reservation *reservation) {
  char path[PATH_MAX]; struct stat st, held, current;
  memset(reservation, 0, sizeof(*reservation));
  if (snprintf(path, sizeof(path), "%s/used.%u", LC_HOST_STATE, uid) >= (int)sizeof(path)) return false;
  int fd = lc_host_open_protected(path, false); if (fd < 0) return false;
  bool okay = !fstat(fd, &st) && st.st_size == sizeof(*reservation) && lc_host_io(fd, reservation, sizeof(*reservation), false);
  if (close(fd)) okay = false;
  unsigned char digest[32]; CC_SHA256(reservation, (CC_LONG)offsetof(lc_host_reservation, digest), digest);
  if (!okay || reservation->version != 1 || reservation->bytes != sizeof(*reservation) ||
      memcmp(digest, reservation->digest, 32) || reservation->binding.abi != LC_HOST_ABI || reservation->binding.reserved ||
      reservation->binding.actor_uid != approval->actor || reservation->binding.execution_uid != uid ||
      memcmp(reservation->resource_id, reservation->binding.resource_id, 32) ||
      fstat(state, &held) || lstat(LC_HOST_STATE, &current) || held.st_dev != current.st_dev || held.st_ino != current.st_ino) return false;
  for (size_t i = 0; i < approval->principal_count; i++) {
    const lc_host_principal *principal = &approval->principals[i];
    if (principal->uid == uid && !memcmp(principal->guid, reservation->binding.principal_guid, 16)) return true;
  }
  return false;
}
static inline bool lc_host_reservation_seen(int state, const lc_host_approval *approval,
    const unsigned char scope[32], bool *seen) {
  int fd = openat(state, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); struct stat held, actual;
  if (fd < 0) return false;
  if (fstat(state, &held) || fstat(fd, &actual) || held.st_dev != actual.st_dev || held.st_ino != actual.st_ino) { close(fd); return false; }
  DIR *directory = fdopendir(fd); if (!directory) { close(fd); return false; }
  bool okay = true; size_t count = 0; *seen = false;
  for (;;) {
    errno = 0; struct dirent *entry = readdir(directory);
    if (!entry) { if (errno) okay = false; break; }
    if (strncmp(entry->d_name, "used.", 5)) continue;
    char *end = NULL, canonical[64]; errno = 0;
    unsigned long uid = strtoul(entry->d_name + 5, &end, 10);
    snprintf(canonical, sizeof(canonical), "used.%lu", uid);
    lc_host_reservation reservation;
    if (++count > LC_HOST_MAX_PRINCIPALS || errno || !end || *end || uid > UINT32_MAX ||
        strcmp(canonical, entry->d_name) || !lc_host_reservation_read(state, approval, (uid_t)uid, &reservation)) { okay = false; break; }
    if (!memcmp(reservation.binding.scope_sha256, scope, 32)) *seen = true;
  }
  if (closedir(directory)) okay = false; return okay;
}
static inline bool lc_host_reserve_principal(int state, const lc_host_approval *approval,
                                            lc_host_writer_binding *binding, lc_host_principal *out) {
  for (size_t i = 0; i < approval->principal_count; i++) {
    const lc_host_principal *principal = &approval->principals[i]; char name[64];
    snprintf(name, sizeof(name), "used.%u", principal->uid);
    int fd = openat(state, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) { if (errno == EEXIST) continue; return false; }
    binding->execution_uid = principal->uid; memcpy(binding->principal_guid, principal->guid, 16);
    lc_host_reservation reservation; memset(&reservation, 0, sizeof(reservation));
    memcpy(reservation.resource_id, binding->resource_id, 32); reservation.version = 1; reservation.bytes = sizeof(reservation);
    reservation.binding = *binding;
    CC_SHA256(&reservation, (CC_LONG)offsetof(lc_host_reservation, digest), reservation.digest);
    /* Consume before checking/mutation. Partial reservations remain blocking;
     * this UID and original attempt are never returned to a provisioning pool. */
    bool okay = lc_host_io(fd, &reservation, sizeof(reservation), true) && lc_host_sync(fd) && lc_host_sync(state);
    if (close(fd)) okay = false;
    if (!okay || !lc_host_principal_valid(principal)) return false;
    *out = *principal; return true;
  }
  return false;
}
/* Signal as the fully dropped identity. The kernel checks the actual process
 * reference's credentials; root never signals a stale numeric PID from a census.
 * The signaling child may itself die. Its return is not closure evidence. */
static inline pid_t lc_host_signal_uid(const lc_host_principal *principal, int fence, int signal_number) {
  pid_t pid = fork();
  if (pid != 0) return pid;
  long maximum = sysconf(_SC_OPEN_MAX);
  if (maximum < 0 || maximum > INT_MAX) _exit(126);
  for (int fd = 0; fd < maximum; fd++) if (fd != fence) close(fd);
  if (setgroups(0, NULL) || setgid(principal->gid) || setuid(principal->uid) ||
      getuid() != principal->uid || geteuid() != principal->uid || getgid() != principal->gid ||
      getegid() != principal->gid || !lc_host_groups_private(principal->gid)) _exit(126);
  close(fence); (void)kill(-1, signal_number); _exit(0);
}

typedef struct {
  uint32_t magic, uid, gid;
  lc_host_file_identity root, fence;
  char cwd[512], command[501], work[PATH_MAX], path[8192];
} lc_host_bootstrap;
#define LC_HOST_BOOTSTRAP_MAGIC 0x4c434831U

static inline bool lc_host_enter_cwd(int root, const char *relative) {
  if (!strcmp(relative, ".")) return fchdir(root) == 0;
  if (!relative[0] || relative[0] == '/' || strlen(relative) >= 500) return false;
  char copy[512]; strcpy(copy, relative); char *save = NULL, *part = strtok_r(copy, "/", &save);
  int current = fcntl(root, F_DUPFD_CLOEXEC, 11);
  if (current < 0) return false;
  while (part) {
    if (!strcmp(part, ".") || !strcmp(part, "..")) { close(current); return false; }
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(current); current = next;
    if (next < 0) return false;
    part = strtok_r(NULL, "/", &save);
  }
  bool okay = fchdir(current) == 0; close(current); return okay;
}
/* Re-entered only AFTER sandbox-exec installed the generated policy. No target
 * or interpreter has run. The private payload FD is supplied by the root parent,
 * and root UID is mandatory; the installed binary is never setid. */
static inline int lc_host_bootstrap_target(void) {
  lc_host_bootstrap input; lc_host_file_identity root, fence;
  if (getuid() != 0 || geteuid() != 0 || !lc_host_io(8, &input, sizeof(input), false) ||
      input.magic != LC_HOST_BOOTSTRAP_MAGIC || input.uid <= 501 || input.gid <= 501 ||
      !memchr(input.cwd, 0, sizeof(input.cwd)) || !memchr(input.command, 0, sizeof(input.command)) ||
      !memchr(input.work, 0, sizeof(input.work)) || !memchr(input.path, 0, sizeof(input.path)) ||
      !lc_host_identity(5, true, &root) || !lc_host_identity(6, false, &fence) ||
      !lc_host_same(root, input.root) || !lc_host_same(fence, input.fence) || !lc_host_enter_cwd(5, input.cwd)) return 126;
  long maximum = sysconf(_SC_OPEN_MAX);
  if (maximum < 9 || maximum > INT_MAX) return 126;
  struct rlimit processes = { 128, 128 }, files = { 1024, 1024 }, core = { 0, 0 };
  if (setrlimit(RLIMIT_NPROC, &processes) || setrlimit(RLIMIT_NOFILE, &files) || setrlimit(RLIMIT_CORE, &core) ||
      setgroups(0, NULL) || setgid(input.gid) || setuid(input.uid)) return 126;
  struct proc_bsdinfo credentials;
  int bytes = proc_pidinfo(getpid(), PROC_PIDTBSDINFO, 0, &credentials, sizeof(credentials));
  if (bytes != sizeof(credentials) || credentials.pbi_uid != input.uid || credentials.pbi_ruid != input.uid ||
      credentials.pbi_svuid != input.uid || credentials.pbi_gid != input.gid || credentials.pbi_rgid != input.gid ||
      credentials.pbi_svgid != input.gid || !lc_host_groups_private(input.gid)) return 126;
  /* Only after sandbox AND full credential drop may authority descriptors close.
   * The UID now witnesses this bootstrap across exec, fork, setsid and reparent. */
  for (int fd = 3; fd < maximum; fd++) close(fd);
  char path[sizeof(input.path) + 6], home[PATH_MAX + 6], temporary[PATH_MAX + 8];
  snprintf(path, sizeof(path), "PATH=%s", input.path); snprintf(home, sizeof(home), "HOME=%s", input.work);
  snprintf(temporary, sizeof(temporary), "TMPDIR=%s", input.work);
  char *environment[] = { path, home, temporary, "LANG=C.UTF-8", "LC_ALL=C.UTF-8", NULL };
  char *args[] = { "/bin/bash", "--noprofile", "--norc", "-c", input.command, NULL };
  execve(args[0], args, environment); return 127;
}
#endif
