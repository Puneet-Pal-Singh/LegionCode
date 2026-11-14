#ifndef LEGIONCODE_HOST_PRINCIPAL_H
#define LEGIONCODE_HOST_PRINCIPAL_H
#include "legioncode-host-approval.h"
#include <grp.h>
#include <sys/resource.h>

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
  uuid_t current; struct passwd value, *found = NULL; char buffer[16384];
  if (principal->uid <= 501 || principal->gid <= 501 ||
      getpwuid_r(principal->uid, &value, buffer, sizeof(buffer), &found) || !found ||
      value.pw_uid != principal->uid || value.pw_gid != principal->gid ||
      (strcmp(value.pw_shell, "/usr/bin/false") && strcmp(value.pw_shell, "/usr/bin/nologin")) ||
      mbr_uid_to_uuid(principal->uid, current) || memcmp(current, principal->guid, sizeof(current))) return false;
  return lc_host_uid_zero(principal->uid);
}
static inline bool lc_host_reserve_principal(int state, const lc_host_approval *approval,
                                            const unsigned char binding[32], lc_host_principal *out) {
  for (size_t i = 0; i < approval->principal_count; i++) {
    const lc_host_principal *principal = &approval->principals[i]; char name[64];
    snprintf(name, sizeof(name), "used.%u", principal->uid);
    int fd = openat(state, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) { if (errno == EEXIST) continue; return false; }
    /* Consume before checking/mutation. Failed/ambiguous reservations are never
     * returned to the pool, and no account/range is installed by this code. */
    bool okay = lc_host_io(fd, (void *)binding, 32, true) && lc_host_sync(fd) && lc_host_sync(state);
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
