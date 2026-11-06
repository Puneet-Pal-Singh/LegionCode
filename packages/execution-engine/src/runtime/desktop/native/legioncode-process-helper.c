/* Trusted POSIX lifetime guardian. Not a lifecycle/event producer.
 *
 * CLI: --timeout-ms N [--term-grace-ms N] [--cwd-fd 5] [--cwd-relative PATH]
 *      [--lease-fd 6] --profile TRUSTED_SEATBELT_PROFILE -- /absolute/executable [argv...]
 * Lock-only CLI: --acquire-lease-fd 6 (FD4 receipt; no target fork).
 * FD3: G releases the stopped child after its started receipt; C/other bytes
 *      cancel; EOF means owner loss. FD4: trusted NDJSON v1 receipts only.
 * FD5: optional granted directory. FD6: shared writer-fence open description.
 * The child closes control/status/root/lease descriptors before policy exec.
 * Lease ownership ends only by close, never LOCK_UN or unlink.
 *
 * Only a terminal receipt following exact-child waitpid proves reaping. Missing
 * receipt/abnormal guardian death must never be interpreted as quiescence.
 */
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE 1
#else
#define _POSIX_C_SOURCE 200809L
#endif

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define CONTROL_FD 3
#define STATUS_FD 4
#define ROOT_FD 5
#define LEASE_FD 6
#define MAX_TIMEOUT_MS UINT64_C(86400000)
#define MAX_GRACE_MS UINT64_C(5000)

static volatile sig_atomic_t guardian_signal;

static void request_shutdown(int value) { guardian_signal = value; }

static bool number(const char *text, uint64_t maximum, uint64_t *value) {
  const unsigned char *cursor = (const unsigned char *)text;
  uint64_t parsed = 0;
  if (*cursor == '\0') return false;
  for (; *cursor != '\0'; ++cursor) {
    unsigned int digit;
    if (*cursor < '0' || *cursor > '9') return false;
    digit = (unsigned int)(*cursor - '0');
    if (parsed > (maximum - digit) / 10) return false;
    parsed = parsed * 10 + digit;
  }
  if (parsed == 0 || parsed > maximum) return false;
  *value = parsed;
  return true;
}

static bool monotonic_ms(uint64_t *value) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec < 0) return false;
  *value = (uint64_t)now.tv_sec * UINT64_C(1000) +
           (uint64_t)now.tv_nsec / UINT64_C(1000000);
  return true;
}

static bool configure_pipe(int descriptor, bool writer) {
  struct stat info;
  int flags = fcntl(descriptor, F_GETFL);
  int descriptor_flags = fcntl(descriptor, F_GETFD);
  if (flags < 0 || descriptor_flags < 0 || fstat(descriptor, &info) != 0)
    return false;
  if (!S_ISFIFO(info.st_mode) && !S_ISSOCK(info.st_mode)) return false;
  if ((writer && (flags & O_ACCMODE) == O_RDONLY) ||
      (!writer && (flags & O_ACCMODE) == O_WRONLY)) return false;
  return fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 &&
         fcntl(descriptor, F_SETFD, descriptor_flags | FD_CLOEXEC) == 0;
}

/* Receipts fit PIPE_BUF. Never block the deadline on an absent/slow reader. */
static bool receipt(const char *data, size_t size) {
  ssize_t written;
  do { written = write(STATUS_FD, data, size); } while (written < 0 && errno == EINTR);
  return written >= 0 && (size_t)written == size;
}

static bool started(pid_t child) {
  char data[128];
  int size = snprintf(data, sizeof(data),
    "{\"v\":1,\"event\":\"started\",\"pid\":%ld,\"gated\":true}\n", (long)child);
  return size > 0 && (size_t)size < sizeof(data) && receipt(data, (size_t)size);
}

static bool terminal(pid_t child, int status, const char *reason) {
  char data[256];
  int size;
  if (WIFEXITED(status)) {
    size = snprintf(data, sizeof(data),
      "{\"v\":1,\"event\":\"terminal\",\"pid\":%ld,\"reason\":\"%s\","
      "\"wait\":\"exited\",\"exitCode\":%d,\"signal\":null}\n",
      (long)child, reason, WEXITSTATUS(status));
  } else if (WIFSIGNALED(status)) {
    size = snprintf(data, sizeof(data),
      "{\"v\":1,\"event\":\"terminal\",\"pid\":%ld,\"reason\":\"%s\","
      "\"wait\":\"signaled\",\"exitCode\":null,\"signal\":%d}\n",
      (long)child, reason, WTERMSIG(status));
  } else return false;
  return size > 0 && (size_t)size < sizeof(data) && receipt(data, (size_t)size);
}

static bool set_handler(int value, void (*handler)(int)) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = handler;
  if (sigemptyset(&action.sa_mask) != 0) return false;
  return sigaction(value, &action, NULL) == 0;
}

/* Caller retains the same open-file description, not a reopened pathname.
 * Closing this helper's duplicate must not explicitly unlock the caller's fence. */
static int acquire_lease(void) {
  struct stat info;
  int flags = fcntl(LEASE_FD, F_GETFD);
  if (flags < 0 || fstat(LEASE_FD, &info) != 0 || !S_ISREG(info.st_mode) ||
      fcntl(LEASE_FD, F_SETFD, flags | FD_CLOEXEC) != 0) return 70;
  while (flock(LEASE_FD, LOCK_EX | LOCK_NB) != 0) {
    if (errno == EINTR) continue;
    return (errno == EWOULDBLOCK || errno == EAGAIN) ? 75 : 70;
  }
  return 0;
}

static int lease_only(void) {
  const char *state;
  char data[96];
  int outcome, size;
  if (!configure_pipe(STATUS_FD, true) || !set_handler(SIGPIPE, SIG_IGN)) return 64;
  outcome = acquire_lease();
  state = outcome == 0 ? "acquired" : (outcome == 75 ? "busy" : "error");
  size = snprintf(data, sizeof(data),
    "{\"v\":1,\"event\":\"lease\",\"state\":\"%s\"}\n", state);
  if (size <= 0 || (size_t)size >= sizeof(data) || !receipt(data, (size_t)size)) outcome = 74;
  (void)close(LEASE_FD);
  (void)close(STATUS_FD);
  return outcome;
}

static void signal_child(pid_t child, int value) {
  /* Unreaped direct-child PID cannot be reused, even after exec/setsid. */
  while (kill(child, value) != 0 && errno == EINTR) {}
}

static bool valid_relative_directory(const char *relative) {
  const char *component = relative;
  if (relative == NULL || relative[0] == '\0' || relative[0] == '/' ||
      strlen(relative) > 4096 || strchr(relative, '\\') != NULL) return false;
  for (const char *cursor = relative;; ++cursor) {
    if (*cursor == '/' || *cursor == '\0') {
      size_t size = (size_t)(cursor - component);
      if (size == 0 || size > 255 ||
          (size == 1 && component[0] == '.') ||
          (size == 2 && component[0] == '.' && component[1] == '.')) return false;
      if (*cursor == '\0') return true;
      component = cursor + 1;
    }
  }
}

/* Anchor every component to the inherited directory; never reopen its pathname. */
static bool enter_root(const char *relative) {
  int current = ROOT_FD;
  const char *cursor = relative;
  if (relative != NULL) {
    while (*cursor != '\0') {
      char component[256];
      const char *end = strchr(cursor, '/');
      size_t size = end == NULL ? strlen(cursor) : (size_t)(end - cursor);
      int next;
      memcpy(component, cursor, size);
      component[size] = '\0';
      do { next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); }
      while (next < 0 && errno == EINTR);
      if (current != ROOT_FD) (void)close(current);
      if (next < 0) return false;
      current = next;
      cursor += size;
      if (*cursor == '/') ++cursor;
    }
  }
  {
    bool entered = fchdir(current) == 0;
    if (current != ROOT_FD) (void)close(current);
    return entered;
  }
}

static void child_exec(char **arguments, bool use_root, const char *relative,
                       long descriptor_limit) {
  sigset_t empty;
  if (!set_handler(SIGPIPE, SIG_DFL) || !set_handler(SIGTERM, SIG_DFL) ||
      !set_handler(SIGINT, SIG_DFL) || !set_handler(SIGHUP, SIG_DFL) ||
      !set_handler(SIGCHLD, SIG_DFL) || sigemptyset(&empty) != 0 ||
      sigprocmask(SIG_SETMASK, &empty, NULL) != 0) _exit(126);
  (void)close(CONTROL_FD);
  (void)close(STATUS_FD);
  (void)close(LEASE_FD);
  if (use_root && !enter_root(relative)) _exit(126);
  (void)close(ROOT_FD);
  for (long descriptor = LEASE_FD + 1; descriptor < descriptor_limit; ++descriptor)
    (void)close((int)descriptor);
  /* No untrusted execution until the guardian observes this exact stop. */
  if (raise(SIGSTOP) != 0) _exit(126);
  execv("/usr/bin/sandbox-exec", arguments);
  _exit(127);
}

int main(int argc, char **argv) {
  uint64_t timeout = 0, grace = 250, now = 0, deadline, kill_at = 0;
  const char *profile = NULL, *reason = NULL, *cwd_relative = NULL;
  bool use_root = false, use_lease = false, grace_seen = false;
  bool stopped = false, announced = false, go = false, resumed = false;
  bool terminating = false, killed = false, status_ok = true;
  int target = 0, status = 0;
  pid_t child;
  long descriptor_limit;
  char **arguments;
  sigset_t empty;

  if (argc == 3 && strcmp(argv[1], "--acquire-lease-fd") == 0 &&
      strcmp(argv[2], "6") == 0) return lease_only();

  for (int index = 1; index < argc; ++index) {
    if (strcmp(argv[index], "--") == 0) { target = index + 1; break; }
    if (index + 1 >= argc) return 64;
    if (strcmp(argv[index], "--timeout-ms") == 0 && timeout == 0) {
      if (!number(argv[++index], MAX_TIMEOUT_MS, &timeout)) return 64;
    } else if (strcmp(argv[index], "--term-grace-ms") == 0 && !grace_seen) {
      if (!number(argv[++index], MAX_GRACE_MS, &grace)) return 64;
      grace_seen = true;
    } else if (strcmp(argv[index], "--cwd-fd") == 0 && !use_root) {
      if (strcmp(argv[++index], "5") != 0) return 64;
      use_root = true;
    } else if (strcmp(argv[index], "--cwd-relative") == 0 && cwd_relative == NULL) {
      cwd_relative = argv[++index];
    } else if (strcmp(argv[index], "--lease-fd") == 0 && !use_lease) {
      if (strcmp(argv[++index], "6") != 0) return 64;
      use_lease = true;
    } else if (strcmp(argv[index], "--profile") == 0 && profile == NULL) {
      profile = argv[++index];
    } else return 64;
  }
  if (timeout == 0 || profile == NULL || profile[0] == '\0' ||
      strlen(profile) > 65536 || target <= 0 || target >= argc ||
      argv[target][0] != '/' ||
      (cwd_relative != NULL && (!use_root || !valid_relative_directory(cwd_relative)))) return 64;
  if (!configure_pipe(CONTROL_FD, false) || !configure_pipe(STATUS_FD, true)) return 64;
  if (use_root) {
    struct stat directory;
    if (fstat(ROOT_FD, &directory) != 0 || !S_ISDIR(directory.st_mode)) return 64;
  }
  if (use_lease) {
    int outcome = acquire_lease();
    if (outcome != 0) return outcome;
  }
  descriptor_limit = sysconf(_SC_OPEN_MAX);
  if (descriptor_limit < ROOT_FD + 1 || descriptor_limit > INT_MAX) return 70;
  if (!set_handler(SIGPIPE, SIG_IGN) || !set_handler(SIGCHLD, SIG_DFL) ||
      !set_handler(SIGTERM, request_shutdown) || !set_handler(SIGINT, request_shutdown) ||
      !set_handler(SIGHUP, request_shutdown) || sigemptyset(&empty) != 0 ||
      sigprocmask(SIG_SETMASK, &empty, NULL) != 0 || !monotonic_ms(&now)) return 70;
  deadline = now + timeout;
  arguments = calloc((size_t)(argc - target) + 4, sizeof(*arguments));
  if (arguments == NULL) return 70;
  arguments[0] = (char *)"/usr/bin/sandbox-exec";
  arguments[1] = (char *)"-p";
  arguments[2] = (char *)profile;
  for (int index = target; index < argc; ++index) arguments[index - target + 3] = argv[index];

  child = fork();
  if (child < 0) { free(arguments); return 71; }
  if (child == 0) child_exec(arguments, use_root, cwd_relative, descriptor_limit);
  free(arguments);
  (void)close(ROOT_FD);

  for (;;) {
    pid_t observed = waitpid(child, &status, WNOHANG | WUNTRACED);
    if (observed == child) {
      if (WIFEXITED(status) || WIFSIGNALED(status)) break;
      if (WIFSTOPPED(status) && !resumed) stopped = true;
    } else if (observed < 0 && errno != EINTR) {
      /* No terminal receipt without an actual terminal wait result. */
      if (errno != ECHILD) {
        signal_child(child, SIGKILL);
        do { observed = waitpid(child, &status, 0); } while (observed < 0 && errno == EINTR);
        if (observed == child && (WIFEXITED(status) || WIFSIGNALED(status))) {
          (void)terminal(child, status, "guardian_error");
        }
      }
      return 71;
    }
    if (stopped && !announced && !terminating) {
      announced = true;
      if (!started(child)) { status_ok = false; reason = "guardian_error"; }
    }
    if (!terminating && reason == NULL) {
      unsigned char commands[32];
      ssize_t count = read(CONTROL_FD, commands, sizeof(commands));
      if (count == 0) reason = "owner_lost";
      else if (count > 0) {
        for (ssize_t index = 0; index < count; ++index) {
          if (commands[index] == 'G' && announced && !resumed && !go) go = true;
          else reason = "cancelled";
        }
      } else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) reason = "guardian_error";
    }
    if (!monotonic_ms(&now)) {
      reason = "guardian_error";
      terminating = true;
      killed = true;
      signal_child(child, SIGKILL);
    }
    if (!terminating) {
      if (reason == NULL && guardian_signal != 0) reason = "guardian_signal";
      if (reason == NULL && now >= deadline) reason = "deadline";
      if (reason != NULL) {
        terminating = true;
        kill_at = now + grace;
        signal_child(child, SIGTERM);
        /* TERM must also reach a stopped child, including the initial gate. */
        signal_child(child, SIGCONT);
      } else if (stopped && go && !resumed) {
        resumed = true;
        signal_child(child, SIGCONT);
      }
    }
    if (terminating && !killed && now >= kill_at) {
      killed = true;
      signal_child(child, SIGKILL);
    }
    {
      struct pollfd control = { terminating ? -1 : CONTROL_FD, POLLIN | POLLHUP | POLLERR, 0 };
      uint64_t next = terminating ? (killed ? now + 25 : kill_at) : deadline;
      int delay = next > now ? (int)((next - now) > 25 ? 25 : next - now) : 0;
      if (poll(&control, 1, delay) < 0 && errno != EINTR && !terminating) reason = "guardian_error";
    }
  }
  /* waitpid has reaped the exact direct child. Output never comes from it. */
  if (!terminal(child, status, reason == NULL ? "exited" : reason)) status_ok = false;
  (void)close(CONTROL_FD);
  (void)close(STATUS_FD);
  /* Reaping precedes the guardian's final fence close; never call LOCK_UN. */
  (void)close(LEASE_FD);
  return status_ok ? 0 : 74;
}
