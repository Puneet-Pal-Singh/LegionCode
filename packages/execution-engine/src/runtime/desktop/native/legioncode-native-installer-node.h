#ifndef LEGIONCODE_NATIVE_INSTALLER_NODE_H
#define LEGIONCODE_NATIVE_INSTALLER_NODE_H
#include <mach-o/loader.h>

static bool install_node_pread(int fd, void *buffer, size_t bytes, off_t offset) {
  unsigned char *cursor = buffer;
  while (bytes) {
    ssize_t count = pread(fd, cursor, bytes, offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    cursor += count; offset += count; bytes -= (size_t)count;
  }
  return true;
}

/* First delivery accepts native-architecture Node executables linked only to
 * the immutable OS runtime. A mutable Homebrew/NVM dylib dependency is not fixed
 * by broadening ReadRoots; it needs a separately captured toolchain snapshot. */
static bool install_node_dependencies(int fd) {
  struct stat before, after; struct mach_header_64 header;
  if (fstat(fd, &before) || !S_ISREG(before.st_mode) || before.st_size < (off_t)sizeof(header) ||
      before.st_size > 256 * 1024 * 1024 || (before.st_mode & 06000) ||
      !install_node_pread(fd, &header, sizeof(header), 0) || header.magic != MH_MAGIC_64 ||
      header.filetype != MH_EXECUTE || !header.ncmds || header.ncmds > 4096 ||
      header.sizeofcmds > 1024 * 1024 || header.sizeofcmds < header.ncmds * sizeof(struct load_command) ||
      (uint64_t)header.sizeofcmds + sizeof(header) > (uint64_t)before.st_size) return false;
#if defined(__arm64__)
  if (header.cputype != CPU_TYPE_ARM64) return false;
#elif defined(__x86_64__)
  if (header.cputype != CPU_TYPE_X86_64) return false;
#else
  return false;
#endif
  off_t offset = sizeof(header), end = offset + header.sizeofcmds;
  for (uint32_t index = 0; index < header.ncmds; index++) {
    struct load_command command;
    if (!install_node_pread(fd, &command, sizeof(command), offset) || command.cmdsize < sizeof(command) ||
        command.cmdsize % 8 || command.cmdsize > (uint64_t)(end - offset)) return false;
    if (command.cmd == LC_RPATH || command.cmd == LC_DYLD_ENVIRONMENT) return false;
    bool library = command.cmd == LC_LOAD_DYLIB || command.cmd == LC_LOAD_WEAK_DYLIB ||
      command.cmd == LC_REEXPORT_DYLIB || command.cmd == LC_LOAD_UPWARD_DYLIB;
    if (library || command.cmd == LC_LOAD_DYLINKER) {
      uint32_t name;
      if (library) {
        struct dylib_command dylib;
        if (command.cmdsize < sizeof(dylib) || !install_node_pread(fd, &dylib, sizeof(dylib), offset)) return false;
        name = dylib.dylib.name.offset;
        if (name < sizeof(dylib)) return false;
      } else {
        struct dylinker_command linker;
        if (command.cmdsize < sizeof(linker) || !install_node_pread(fd, &linker, sizeof(linker), offset)) return false;
        name = linker.name.offset;
        if (name < sizeof(linker)) return false;
      }
      char path[PATH_MAX];
      if (name >= command.cmdsize || command.cmdsize - name > sizeof(path) ||
          !install_node_pread(fd, path, command.cmdsize - name, offset + name) ||
          !memchr(path, 0, command.cmdsize - name) || strstr(path, "/../") || strstr(path, "/./") ||
          (strncmp(path, "/usr/lib/", 9) && strncmp(path, "/System/Library/", 16))) return false;
    }
    offset += command.cmdsize;
  }
  return offset == end && !fstat(fd, &after) && before.st_dev == after.st_dev && before.st_ino == after.st_ino &&
    before.st_size == after.st_size && before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
    before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec && before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec &&
    before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec;
}
#endif
