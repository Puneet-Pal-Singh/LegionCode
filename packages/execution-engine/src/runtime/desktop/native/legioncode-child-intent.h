#ifndef LEGIONCODE_CHILD_INTENT_H
#define LEGIONCODE_CHILD_INTENT_H
/* Physical child lifetime WAL on the SAME writer inode, not another
 * writer lock or lifecycle store. No executable, argv, path or credential bytes.
 * Fixed 256-byte records: 224-byte canonical body + SHA-256. Whole records are
 * append-only; an incomplete final record never authorized START. Full corrupt
 * records, unknown ABI, full WAL and uncertain exclusion fail closed.
 *
 * Pinned Darwin ABI: Apple XNU f6217f891ac0bb64f3d375211650a4c1ff8ca1ea,
 * bsd/sys/proc_info_private.h (flavor18, 56-byte uniqidentifier suffix),
 * bsd/kern/proc_info.c, kern_proc.c, kern_exec.c, kern_exit.c. pidversion changes
 * across exec; only boot+PID+p_uniqueid identifies the durable lifetime.
 */
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define LC_INTENT_RECORD_BYTES 256U
#define LC_INTENT_MAX_BYTES (4U * 1024U * 1024U)
#define LC_INTENT_MAX_RECORDS (LC_INTENT_MAX_BYTES / LC_INTENT_RECORD_BYTES)
typedef struct { unsigned char bytes[LC_INTENT_RECORD_BYTES]; } lc_child_intent;

#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <limits.h>
#include <mach/message.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <time.h>

/* The API is in public libproc.h; absence must not select PID-only signaling. */
extern int proc_signal_with_audittoken(audit_token_t *, int) __attribute__((weak_import));
struct lc_proc_unique {
  unsigned char uuid[16];
  uint64_t uniqueid, parent_uniqueid;
  int32_t idversion, original_parent_idversion;
  uint64_t reserved[2];
};
_Static_assert(sizeof(struct lc_proc_unique) == 56, "Pinned Darwin process identity ABI");
struct lc_proc_bsd_unique { struct proc_bsdinfo bsd; struct lc_proc_unique unique; };
_Static_assert(sizeof(struct lc_proc_bsd_unique) == sizeof(struct proc_bsdinfo) + 56,
               "Pinned Darwin combined identity ABI");
typedef struct {
  lc_child_intent header;
  lc_child_intent *intents;
  unsigned char *pending;
  size_t count, active;
  off_t complete_bytes;
} lc_intent_log;

static inline uint64_t lc_get64(const unsigned char *p) {
  uint64_t n = 0; for (unsigned int i = 0; i < 8; ++i) n = (n << 8) | p[i]; return n;
}
static inline void lc_put64(unsigned char *p, uint64_t n) {
  for (unsigned int i = 8; i > 0; --i) { p[i - 1] = (unsigned char)n; n >>= 8; }
}
static inline bool lc_clock(uint64_t *now) {
  struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t) || t.tv_sec < 0) return false;
  *now = (uint64_t)t.tv_sec * 1000U + (uint64_t)t.tv_nsec / 1000000U; return true;
}
static inline bool lc_pause(uint64_t deadline) {
  uint64_t now; struct timespec delay = { 0, 10000000 };
  if (!lc_clock(&now) || now >= deadline) return false;
  while (nanosleep(&delay, &delay) && errno == EINTR) {}
  return true;
}
static inline bool lc_boot(unsigned char out[40]) {
  char uuid[40] = {0}; size_t size = sizeof(uuid);
  if (sysctlbyname("kern.bootsessionuuid", uuid, &size, NULL, 0) ||
      size != 37 || uuid[36] != '\0' || strlen(uuid) != 36) return false;
  memset(out, 0, 40);
  for (unsigned int i = 0; i < 36; ++i) {
    char c = uuid[i]; if (c >= 'A' && c <= 'F') c = (char)(c + 'a' - 'A');
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') return false; }
    else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    out[i] = (unsigned char)c;
  }
  return true;
}
static inline bool lc_identity(pid_t pid, struct lc_proc_bsd_unique *out) {
  memset(out, 0, sizeof(*out)); errno = 0;
  /* arg1 includes exiting/zombie procs: ref-drain precedes blocking AIO/FD cleanup. */
  int size = proc_pidinfo(pid, 18, 1, out, (int)sizeof(*out));
  return size == (int)sizeof(*out) && out->bsd.pbi_pid == (uint32_t)pid && out->unique.uniqueid != 0;
}
static inline bool lc_supported(void) {
  struct lc_proc_bsd_unique self; unsigned char boot[40];
  return proc_signal_with_audittoken != NULL && lc_boot(boot) && lc_identity(getpid(), &self);
}
/* Public Darwin OFD byte0 fence: same inherited open description, last-close
 * release. Old whole-file flock holders overlap it and therefore still block.
 * Byte1 is reserved for the POSIX append serializer; never expand this fence
 * back into flock or both lock domains would self-block on the same inode. */
static inline int lc_writer_lock(int fd) {
  struct flock lock; memset(&lock, 0, sizeof(lock));
  lock.l_type = F_WRLCK; lock.l_whence = SEEK_SET; lock.l_len = 1;
  for (;;) {
    if (fcntl(fd, F_OFD_SETLK, &lock) == 0) return 0;
    if (errno == EINTR) continue;
    return (errno == EWOULDBLOCK || errno == EAGAIN || errno == EACCES) ? 75 : 70;
  }
}
static inline bool lc_intent_probe(void) {
  struct lc_proc_bsd_unique self;
  if (!lc_supported() || !lc_identity(getpid(), &self)) return false;
  audit_token_t token; memset(&token, 0, sizeof(token));
  token.val[5] = (uint32_t)getpid(); token.val[7] = (uint32_t)self.unique.idversion;
  if (proc_signal_with_audittoken(&token, SIGCONT) != 0) return false;
  /* A private, immediately removed probe inode exercises the actual lock ABI
   * without opening a workspace/root/fence or creating a target process. */
  char path[] = "/tmp/legioncode-writer-probe.XXXXXX";
  int first = mkstemp(path), second = -1; bool okay = false;
  if (first < 0) return false;
  second = open(path, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  struct stat a, b;
  if (second < 0 || fstat(first, &a) || fstat(second, &b) || a.st_dev != b.st_dev || a.st_ino != b.st_ino ||
      !S_ISREG(a.st_mode) || a.st_uid != geteuid() || (a.st_mode & 0777) != 0600) goto out;
  if (unlink(path)) goto out;
  path[0] = '\0';
  if (lc_writer_lock(first) != 0) goto out;
  /* An old whole-file flock on a distinct description must see the OFD fence. */
  errno = 0;
  if (flock(second, LOCK_EX | LOCK_NB) == 0 || (errno != EWOULDBLOCK && errno != EAGAIN)) goto out;
  struct flock append; memset(&append, 0, sizeof(append));
  append.l_type = F_WRLCK; append.l_whence = SEEK_SET; append.l_start = 1; append.l_len = 1;
  if (fcntl(first, F_SETLK, &append)) goto out;
  okay = true;
out:
  if (path[0] && unlink(path)) okay = false;
  if (second >= 0 && close(second)) okay = false;
  if (close(first)) okay = false;
  return okay;
}
static inline bool lc_journal_lock(int fd, uint64_t deadline, bool unlock) {
  struct flock lock; memset(&lock, 0, sizeof(lock));
  lock.l_type = unlock ? F_UNLCK : F_WRLCK; lock.l_whence = SEEK_SET; lock.l_start = 1; lock.l_len = 1;
  /* This byte-range lock serializes records only. It never unlocks the flock
   * OFD byte0 fence shared by the original open description and every guardian. */
  for (;;) {
    if (fcntl(fd, F_SETLK, &lock) == 0) return true;
    if (unlock || (errno != EACCES && errno != EAGAIN && errno != EINTR) || !lc_pause(deadline)) return false;
  }
}
static inline bool lc_digest(lc_child_intent *record, bool validate) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (!CC_SHA256(record->bytes, 224, digest)) return false;
  if (validate) return memcmp(digest, record->bytes + 224, sizeof(digest)) == 0;
  memcpy(record->bytes + 224, digest, sizeof(digest)); return true;
}
static inline bool lc_boot_field(const unsigned char *boot) {
  for (unsigned int i = 0; i < 36; ++i) {
    unsigned char c = boot[i];
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') return false; }
    else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return boot[36] == 0 && boot[37] == 0 && boot[38] == 0 && boot[39] == 0;
}
static inline bool lc_io(int fd, unsigned char *data, size_t length, off_t offset, bool write_record) {
  while (length) {
    ssize_t done = write_record ? pwrite(fd, data, length, offset) : pread(fd, data, length, offset);
    if (done < 0 && errno == EINTR) continue;
    if (done <= 0) return false;
    data += done; offset += done; length -= (size_t)done;
  }
  return true;
}
static inline bool lc_sync(int fd) {
  int result; do { result = fsync(fd); } while (result && errno == EINTR); return result == 0;
}
static inline bool lc_same_binding(const lc_child_intent *a, const lc_child_intent *b) {
  return memcmp(a->bytes + 24, b->bytes + 24, 48) == 0;
}
static inline bool lc_record_valid(lc_child_intent *record, size_t ordinal) {
  if (memcmp(record->bytes, "LCNFI001", 8) || lc_get64(record->bytes + 16) != ordinal || !lc_digest(record, true)) return false;
  for (unsigned int i = 9; i < 16; ++i) if (record->bytes[i]) return false;
  for (unsigned int i = 144; i < 224; ++i) if (record->bytes[i]) return false;
  if (record->bytes[8] != 'H' && record->bytes[8] != 'I' && record->bytes[8] != 'D') return false;
  if (!lc_boot_field(record->bytes + 72)) return false;
  if (record->bytes[8] == 'H') return ordinal == 1 && lc_get64(record->bytes + 112) == 0 && lc_get64(record->bytes + 120) == 0 && lc_get64(record->bytes + 128) == 0 && lc_get64(record->bytes + 136) == 0;
  return ordinal > 1 && lc_get64(record->bytes + 112) > 1 &&
    lc_get64(record->bytes + 112) <= INT_MAX && lc_get64(record->bytes + 120) != 0 &&
    lc_get64(record->bytes + 128) != 0 && lc_get64(record->bytes + 136) <= UINT32_MAX;
}
static inline void lc_log_free(lc_intent_log *log) {
  free(log->intents); free(log->pending); memset(log, 0, sizeof(*log));
}
static inline bool lc_log_read(int fd, lc_intent_log *log, bool allow_tail) {
  struct stat file; memset(log, 0, sizeof(*log));
  if (fstat(fd, &file) || !S_ISREG(file.st_mode) || file.st_size < (off_t)LC_INTENT_RECORD_BYTES ||
      file.st_size > LC_INTENT_MAX_BYTES || (!allow_tail && file.st_size % LC_INTENT_RECORD_BYTES)) return false;
  log->count = (size_t)file.st_size / LC_INTENT_RECORD_BYTES;
  log->complete_bytes = (off_t)(log->count * LC_INTENT_RECORD_BYTES);
  log->intents = calloc(log->count, sizeof(*log->intents)); log->pending = calloc(log->count, 1);
  if (!log->intents || !log->pending) { lc_log_free(log); return false; }
  for (size_t i = 0; i < log->count; ++i) {
    lc_child_intent record;
    if (!lc_io(fd, record.bytes, sizeof(record.bytes), (off_t)(i * sizeof(record.bytes)), false) || !lc_record_valid(&record, i + 1)) goto invalid;
    if (i == 0) { log->header = record; continue; }
    if (!lc_same_binding(&record, &log->header) || record.bytes[8] == 'H') goto invalid;
    uint64_t intent = lc_get64(record.bytes + 128);
    if (record.bytes[8] == 'I') {
      if (intent != i + 1) goto invalid;
      log->intents[i] = record; log->pending[i] = 1; log->active++;
    } else {
      if (intent <= 1 || intent > i || !log->pending[intent - 1] ||
          memcmp(record.bytes + 72, log->intents[intent - 1].bytes + 72, 72)) goto invalid;
      log->pending[intent - 1] = 0; log->active--;
    }
  }
  return true;
invalid:
  lc_log_free(log); return false;
}
static inline bool lc_append(int fd, lc_child_intent *record, size_t ordinal) {
  if (ordinal == 0 || ordinal > LC_INTENT_MAX_RECORDS) return false;
  lc_put64(record->bytes + 16, ordinal);
  return lc_digest(record, false) && lc_io(fd, record->bytes, sizeof(record->bytes),
    (off_t)((ordinal - 1) * sizeof(record->bytes)), true) && lc_sync(fd);
}
static inline bool lc_borrowed_header(int fd, int root_fd, lc_child_intent *header) {
  struct stat root, lease;
  return fstat(root_fd, &root) == 0 && S_ISDIR(root.st_mode) && fstat(fd, &lease) == 0 &&
    S_ISREG(lease.st_mode) && lc_io(fd, header->bytes, sizeof(header->bytes), 0, false) &&
    lc_record_valid(header, 1) && header->bytes[8] == 'H' &&
    lc_get64(header->bytes + 24) == (uint64_t)root.st_dev && lc_get64(header->bytes + 32) == (uint64_t)root.st_ino &&
    lc_get64(header->bytes + 56) == (uint64_t)lease.st_dev && lc_get64(header->bytes + 64) == (uint64_t)lease.st_ino &&
    lc_writer_lock(fd) == 0;
}
static inline bool lc_exclude(const lc_child_intent *intent, uint64_t deadline) {
  unsigned char boot[40]; if (!lc_boot(boot)) return false;
  if (memcmp(boot, intent->bytes + 72, sizeof(boot))) return true;
  pid_t pid = (pid_t)lc_get64(intent->bytes + 112);
  for (;;) {
    struct lc_proc_bsd_unique process;
    if (!lc_identity(pid, &process)) { if (errno == ESRCH) return true; return false; }
    if (process.unique.uniqueid != lc_get64(intent->bytes + 120) || process.bsd.pbi_status == 5 /* SZOMB */) return true;
    audit_token_t token; memset(&token, 0, sizeof(token));
    token.val[5] = (uint32_t)pid; token.val[7] = (uint32_t)process.unique.idversion;
    int outcome = proc_signal_with_audittoken(&token, SIGKILL);
    /* ESRCH may mean exec changed pidversion. Re-read the stable lifetime. */
    if (outcome && outcome != ESRCH) return false;
    if (!lc_pause(deadline)) return false;
  }
}
static inline bool lc_intent_acquire(int fd, int root_fd, int namespace_fd) {
  struct stat root, lease, directory; uint64_t now;
  if (!lc_supported() || !lc_clock(&now) || fstat(root_fd, &root) || !S_ISDIR(root.st_mode) ||
      fstat(fd, &lease) || !S_ISREG(lease.st_mode) || lease.st_uid != geteuid() || (lease.st_mode & 0777) != 0600 ||
      fstat(namespace_fd, &directory) || !S_ISDIR(directory.st_mode) || directory.st_uid != geteuid() ||
      (directory.st_mode & 0777) != 0700) return false;
  uint64_t deadline = now + 4000; if (!lc_journal_lock(fd, deadline, false)) return false;
  bool okay = false; lc_intent_log log; memset(&log, 0, sizeof(log));
  if (lease.st_size < (off_t)LC_INTENT_RECORD_BYTES) {
    unsigned char prefix[LC_INTENT_RECORD_BYTES];
    if (lease.st_size < 0 || (lease.st_size && (!lc_io(fd, prefix, (size_t)lease.st_size, 0, false) ||
        memcmp(prefix, "LCNFI001H", (size_t)lease.st_size < 9 ? (size_t)lease.st_size : 9)))) goto out;
    lc_child_intent header; memset(&header, 0, sizeof(header)); memcpy(header.bytes, "LCNFI001H", 9);
    lc_put64(header.bytes + 24, (uint64_t)root.st_dev); lc_put64(header.bytes + 32, (uint64_t)root.st_ino);
    lc_put64(header.bytes + 40, (uint64_t)directory.st_dev); lc_put64(header.bytes + 48, (uint64_t)directory.st_ino);
    lc_put64(header.bytes + 56, (uint64_t)lease.st_dev); lc_put64(header.bytes + 64, (uint64_t)lease.st_ino);
    if (!lc_boot(header.bytes + 72) || ftruncate(fd, 0) || !lc_append(fd, &header, 1)) goto out;
  }
  if (!lc_log_read(fd, &log, true) || !lc_borrowed_header(fd, root_fd, &log.header) ||
      lc_get64(log.header.bytes + 40) != (uint64_t)directory.st_dev ||
      lc_get64(log.header.bytes + 48) != (uint64_t)directory.st_ino) goto out;
  /* A partial last record never crossed its fsync/START barrier. Preserve every
   * full record; only this uncommitted tail may be removed under exclusive OFD fence. */
  if (ftruncate(fd, log.complete_bytes) || !lc_sync(fd)) goto out;
  size_t original_count = log.count, ordinal = log.count;
  for (size_t i = 1; i < original_count; ++i) if (log.pending[i]) {
    if (!lc_exclude(&log.intents[i], deadline)) goto out;
    lc_child_intent done = log.intents[i]; done.bytes[8] = 'D';
    if (!lc_append(fd, &done, ++ordinal)) goto out;
    log.pending[i] = 0;
  }
  okay = true;
out:
  lc_log_free(&log);
  if (!lc_journal_lock(fd, deadline, true)) okay = false;
  return okay;
}
static inline bool lc_intent_begin(int fd, int root_fd, pid_t child, lc_child_intent *intent) {
  uint64_t now; struct lc_proc_bsd_unique process;
  if (!lc_supported() || child <= 1 || !lc_identity(child, &process) || !lc_clock(&now)) return false;
  uint64_t deadline = now + 4000; if (!lc_journal_lock(fd, deadline, false)) return false;
  lc_intent_log log; bool okay = false;
  if (!lc_log_read(fd, &log, false)) goto unlock;
  lc_child_intent header;
  if (!lc_borrowed_header(fd, root_fd, &header) || log.count + log.active + 2 > LC_INTENT_MAX_RECORDS) goto out;
  *intent = header; intent->bytes[8] = 'I';
  lc_put64(intent->bytes + 112, (uint64_t)child); lc_put64(intent->bytes + 120, process.unique.uniqueid);
  lc_put64(intent->bytes + 128, log.count + 1); lc_put64(intent->bytes + 136, (uint32_t)process.unique.idversion);
  if (!lc_boot(intent->bytes + 72) || !lc_append(fd, intent, log.count + 1)) goto out;
  okay = true;
out:
  lc_log_free(&log);
unlock:
  if (!lc_journal_lock(fd, deadline, true)) okay = false;
  return okay;
}
static inline bool lc_intent_complete(int fd, const lc_child_intent *intent) {
  uint64_t now; if (!lc_clock(&now)) return false;
  uint64_t deadline = now + 4000; if (!lc_journal_lock(fd, deadline, false)) return false;
  lc_intent_log log; bool okay = false;
  if (!lc_log_read(fd, &log, false)) goto unlock;
  uint64_t ordinal = lc_get64(intent->bytes + 128);
  if (ordinal <= 1 || ordinal > log.count || !log.pending[ordinal - 1] ||
      memcmp(log.intents[ordinal - 1].bytes, intent->bytes, sizeof(intent->bytes))) goto out;
  lc_child_intent done = *intent; done.bytes[8] = 'D';
  okay = lc_append(fd, &done, log.count + 1);
out:
  lc_log_free(&log);
unlock:
  if (!lc_journal_lock(fd, deadline, true)) okay = false;
  return okay;
}
#else
/* No guessed PID-only or timestamp fallback on unsupported native APIs. */
static inline int lc_writer_lock(int fd) { (void)fd; return 70; }
static inline bool lc_intent_probe(void) { return false; }
static inline bool lc_intent_acquire(int fd, int root, int directory) { (void)fd; (void)root; (void)directory; return false; }
static inline bool lc_borrowed_header(int fd, int root, lc_child_intent *header) { (void)fd; (void)root; (void)header; return false; }
static inline bool lc_intent_begin(int fd, int root, pid_t child, lc_child_intent *intent) { (void)fd; (void)root; (void)child; (void)intent; return false; }
static inline bool lc_intent_complete(int fd, const lc_child_intent *intent) { (void)fd; (void)intent; return false; }
#endif
#endif
