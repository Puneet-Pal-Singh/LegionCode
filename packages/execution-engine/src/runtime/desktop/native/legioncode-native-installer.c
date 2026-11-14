/* Invoked only by the explicitly installed Mac package, never by a readiness
 * probe. This stages the existing broker; it cannot qualify agent execution. */
#include "legioncode-host-approval.h"
#include <fts.h>

#define LC_INSTALL_APP "/Library/Application Support/LegionCode/Applications/LegionCode Desktop.app"
#define LC_INSTALL_SELF "/Library/PrivilegedHelperTools/dev.legioncode.desktop.native-host-installer"
#define LC_INSTALL_PARENT "/Library/Application Support/LegionCode"
#define LC_INSTALL_APPLICATIONS LC_INSTALL_PARENT "/Applications"
#define LC_INSTALL_SHORTCUT "/Applications/LegionCode Desktop.app"
#define LC_INSTALL_DIRECTORY LC_INSTALL_PARENT "/NativeExecution"
#define LC_INSTALL_LAUNCH "/Library/LaunchDaemons/dev.legioncode.desktop.native-host.plist"

static bool install_absent(const char *path) {
  struct stat st; errno = 0;
  return lstat(path, &st) != 0 && errno == ENOENT;
}

static bool install_same_bytes(const char *left, const char *right) {
  unsigned char digest[32], buffer[32768]; char hex[65];
  int fd = lc_host_open_protected(left, false);
  if (fd < 0) return false;
  struct stat st; bool okay = !fstat(fd, &st) && st.st_size > 0 && st.st_size <= 64 * 1024 * 1024;
  CC_SHA256_CTX hash; CC_SHA256_Init(&hash);
  while (okay) {
    ssize_t n = read(fd, buffer, sizeof(buffer));
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) okay = false;
    if (n <= 0) break;
    CC_SHA256_Update(&hash, buffer, (CC_LONG)n);
  }
  CC_SHA256_Final(digest, &hash); lc_host_hex(digest, sizeof(digest), hex, sizeof(hex));
  if (close(fd)) okay = false;
  return okay && lc_host_sha_file(right, hex);
}

/* The package installs a root-owned application. Never recursively chmod,
 * chown or repair an existing user application to make this check pass. */
static bool install_application_valid(void) {
  int root = lc_host_open_protected(LC_INSTALL_APP, true);
  if (root < 0) return false;
  if (close(root)) return false;
  char path[] = LC_INSTALL_APP; char *paths[] = { path, NULL };
  FTS *tree = fts_open(paths, FTS_PHYSICAL | FTS_NOCHDIR, NULL);
  if (!tree) return false;
  bool okay = true; size_t entries = 0; FTSENT *entry;
  for (;;) {
    errno = 0; entry = fts_read(tree);
    if (!entry) { if (errno) okay = false; break; }
    if (++entries > 100000 || entry->fts_info == FTS_ERR || entry->fts_info == FTS_DNR ||
        entry->fts_info == FTS_NS || !entry->fts_statp || entry->fts_statp->st_uid != 0) { okay = false; break; }
    if (entry->fts_info == FTS_DP) continue;
    if (entry->fts_info == FTS_SL || entry->fts_info == FTS_SLNONE) {
      char resolved[PATH_MAX];
      if (!realpath(entry->fts_path, resolved) || !lc_host_beneath(LC_INSTALL_APP, resolved)) { okay = false; break; }
      continue;
    }
    if (entry->fts_info != FTS_F && entry->fts_info != FTS_D) { okay = false; break; }
    int fd = open(entry->fts_path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC |
      (entry->fts_info == FTS_D ? O_DIRECTORY : 0));
    if (fd < 0) { okay = false; break; }
    bool protected = lc_host_protected_fd(fd, entry->fts_info == FTS_D) &&
      !(entry->fts_statp->st_mode & (S_ISUID | S_ISGID));
    if (close(fd)) protected = false;
    if (!protected) { okay = false; break; }
  }
  if (fts_close(tree)) okay = false;
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const unsigned char *)LC_INSTALL_APP,
    strlen(LC_INSTALL_APP), true);
  SecStaticCodeRef code = NULL; CFDictionaryRef information = NULL;
  okay = okay && url && SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess &&
    SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode,
      NULL) == errSecSuccess && SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information) == errSecSuccess &&
    CFDictionaryContainsKey(information, kSecCodeInfoIdentifier) &&
    CFEqual(CFDictionaryGetValue(information, kSecCodeInfoIdentifier), CFSTR("dev.legioncode.desktop"));
  if (information) CFRelease(information); if (code) CFRelease(code); if (url) CFRelease(url);
  return okay;
}

static int install_directory(int parent, const char *name, mode_t mode) {
  if (mkdirat(parent, name, mode)) return -1;
  int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat st;
  if (fd < 0) return -1;
  /* Only this just-created inode is changed. An inherited ACE must not make
   * the qualification work root writable or inaccessible to its actor. */
  acl_t empty = acl_init(0);
  bool clean_acl = empty && !acl_set_fd_np(fd, empty, ACL_TYPE_EXTENDED);
  if (empty) acl_free(empty);
  if (!clean_acl || fchmod(fd, mode) || !lc_host_protected_fd(fd, true) || fstat(fd, &st) || (st.st_mode & 07777) != mode ||
      !lc_host_sync(fd) || !lc_host_sync(parent)) { close(fd); return -1; }
  return fd;
}

static bool install_write(int parent, const char *name, const void *bytes, size_t count, mode_t mode) {
  int fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode);
  if (fd < 0) return false;
  bool okay = !fchmod(fd, mode) && lc_host_protected_fd(fd, false) &&
    lc_host_io(fd, (void *)bytes, count, true) && lc_host_sync(fd);
  if (close(fd)) okay = false;
  return okay && lc_host_sync(parent);
}

/* No common-system directory is carried in the package BOM or repaired. This
 * preinstall program can create only our two private application parents. */
static int install_preflight(void) {
  if (getuid() || geteuid() || !install_absent(LC_INSTALL_DIRECTORY) || !install_absent(LC_HOST_WORK) ||
      !install_absent(LC_INSTALL_LAUNCH) || !install_absent(LC_INSTALL_APP) || !install_absent(LC_INSTALL_SHORTCUT) ||
      !install_absent(LC_HOST_INSTALLED_BROKER) || !install_absent(LC_INSTALL_SELF)) return 77;
  int library = lc_host_open_protected("/Library/Application Support", true);
  if (library < 0) return 77;
  int parent = lc_host_open_protected(LC_INSTALL_PARENT, true);
  if (parent < 0 && install_absent(LC_INSTALL_PARENT)) parent = install_directory(library, "LegionCode", 0755);
  if (close(library) || parent < 0) { if (parent >= 0) close(parent); return 74; }
  int applications = lc_host_open_protected(LC_INSTALL_APPLICATIONS, true);
  if (applications < 0 && install_absent(LC_INSTALL_APPLICATIONS)) applications = install_directory(parent, "Applications", 0755);
  bool okay = applications >= 0;
  if (applications >= 0 && close(applications)) okay = false;
  if (close(parent)) okay = false;
  return okay ? 0 : 74;
}

static bool install_copy_helper(const char *name, const char *installed) {
  char source[PATH_MAX];
  if (snprintf(source, sizeof(source), "%s/Contents/Resources/native/%s", LC_INSTALL_APP, name) >= (int)sizeof(source)) return false;
  int input = lc_host_open_protected(source, false);
  int parent = lc_host_open_protected("/Library/PrivilegedHelperTools", true);
  if (parent < 0 && install_absent("/Library/PrivilegedHelperTools")) {
    int library = lc_host_open_protected("/Library", true);
    if (library >= 0) { parent = install_directory(library, "PrivilegedHelperTools", 0755); if (close(library)) { if (parent >= 0) close(parent); parent = -1; } }
  }
  struct stat st;
  bool okay = input >= 0 && parent >= 0 && !fstat(input, &st) && S_ISREG(st.st_mode) &&
    st.st_size > 0 && st.st_size <= 64 * 1024 * 1024 && (st.st_mode & 0111) && !(st.st_mode & 06000);
  const char *leaf = strrchr(installed, '/');
  int output = okay && leaf ? openat(parent, leaf + 1, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600) : -1;
  if (output < 0) okay = false;
  uint64_t copied = 0;
  while (okay) {
    unsigned char bytes[32768]; ssize_t count = read(input, bytes, sizeof(bytes));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) okay = false;
    if (count <= 0) break;
    copied += (uint64_t)count;
    if (copied > (uint64_t)st.st_size || !lc_host_io(output, bytes, (size_t)count, true)) okay = false;
  }
  okay = okay && copied == (uint64_t)st.st_size && !fchmod(output, 0555) &&
    lc_host_protected_fd(output, false) && lc_host_sync(output);
  if (input >= 0 && close(input)) okay = false;
  if (output >= 0 && close(output)) okay = false;
  if (parent >= 0) { if (!lc_host_sync(parent)) okay = false; if (close(parent)) okay = false; }
  return okay && install_same_bytes(installed, source);
}

static bool install_shortcut(void) {
  /* /Applications may legitimately be admin-group writable. The shortcut is
   * only navigation, never the trusted application or bridge identity. */
  int parent = open("/Applications", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent < 0) return false;
  struct stat st;
  bool okay = !fstat(parent, &st) && S_ISDIR(st.st_mode) && !st.st_uid && !(st.st_mode & 0002) &&
    !symlinkat(LC_INSTALL_APP, parent, "LegionCode Desktop.app") && lc_host_sync(parent);
  if (close(parent)) okay = false;
  return okay;
}

static bool install_launch_description(void) {
  static const char plist[] =
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
    "<plist version=\"1.0\"><dict>"
    "<key>Label</key><string>" LC_HOST_SERVICE "</string>"
    "<key>ProgramArguments</key><array><string>" LC_HOST_INSTALLED_BROKER "</string><string>--serve</string></array>"
    "<key>UserName</key><string>root</string><key>GroupName</key><string>wheel</string>"
    "<key>MachServices</key><dict><key>" LC_HOST_SERVICE "</key><true/></dict>"
    "<key>RunAtLoad</key><false/><key>KeepAlive</key><false/>"
    "<key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>"
    "<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>"
    "</dict></plist>\n";
  int parent = lc_host_open_protected("/Library/LaunchDaemons", true);
  if (parent < 0) return false;
  bool okay = install_write(parent, "dev.legioncode.desktop.native-host.plist", plist, sizeof(plist) - 1, 0644);
  if (close(parent)) okay = false;
  return okay;
}

static bool install_register(void) {
  pid_t child = fork();
  if (child < 0) return false;
  if (!child) {
    long bound = sysconf(_SC_OPEN_MAX);
    if (bound < 3 || bound > INT_MAX) _exit(126);
    for (int fd = 3; fd < bound; fd++) close(fd);
    char *args[] = { "/bin/launchctl", "bootstrap", "system", LC_INSTALL_LAUNCH, NULL };
    char *environment[] = { "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=C", NULL };
    execve(args[0], args, environment); _exit(127);
  }
  uint64_t deadline, now;
  if (!lc_host_monotonic(&deadline)) return false;
  deadline += 30000;
  for (;;) {
    int status; pid_t result = waitpid(child, &status, WNOHANG);
    if (result == child) return WIFEXITED(status) && !WEXITSTATUS(status);
    if (result < 0 && errno != EINTR) return false;
    if (!lc_host_monotonic(&now) || now >= deadline) {
      /* A timeout is not rollback evidence. Keep the pending install and every
       * created artifact even after the exact original command is reaped. */
      (void)kill(child, SIGKILL);
      do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
      return false;
    }
    struct timespec pause = { 0, 10000000 }; (void)nanosleep(&pause, NULL);
  }
}

static int install_stage(void) {
  if (getuid() || geteuid() || !install_absent(LC_INSTALL_DIRECTORY) || !install_absent(LC_HOST_WORK) ||
      !install_absent(LC_INSTALL_LAUNCH) || !install_absent(LC_INSTALL_SHORTCUT) ||
      !install_absent(LC_HOST_INSTALLED_BROKER) || !install_absent(LC_INSTALL_SELF) || !install_application_valid()) return 77;
  int library = lc_host_open_protected("/Library/Application Support", true);
  if (library < 0) return 77;
  int parent = lc_host_open_protected(LC_INSTALL_PARENT, true);
  if (parent < 0 && install_absent(LC_INSTALL_PARENT)) parent = install_directory(library, "LegionCode", 0755);
  if (close(library) || parent < 0) { if (parent >= 0) close(parent); return 74; }
  int state = install_directory(parent, "NativeExecution", 0755);
  if (close(parent) || state < 0) { if (state >= 0) close(state); return 74; }
  static const char pending[] = "LegionCode native setup stage v1: pending; execution unqualified\n";
  bool okay = install_write(state, "install.pending", pending, sizeof(pending) - 1, 0600);
  int resources = okay ? install_directory(state, "resources", 0700) : -1;
  if (resources < 0) okay = false;
  else if (close(resources)) okay = false;
  int temporary = okay ? lc_host_open_protected("/private/var", true) : -1;
  int work = temporary >= 0 ? install_directory(temporary, "legioncode-native-work", 0711) : -1;
  if (work < 0) okay = false;
  else if (close(work)) okay = false;
  if (temporary >= 0 && close(temporary)) okay = false;
  okay = okay && install_copy_helper("legioncode-host-broker", LC_HOST_INSTALLED_BROKER) &&
    install_copy_helper("legioncode-native-installer", LC_INSTALL_SELF) && install_shortcut() &&
    install_launch_description() && install_register();
  if (okay) okay = !renameat(state, "install.pending", state, "install.staged") && lc_host_sync(state);
  if (close(state)) okay = false;
  /* No approval, account, permit or qualification receipt is manufactured. A
   * partial installation is never made retryable by deleting its obligations. */
  return okay ? 0 : 74;
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--preflight")) return install_preflight();
  if (argc == 2 && !strcmp(argv[1], "--stage")) return install_stage();
  return 64;
}
