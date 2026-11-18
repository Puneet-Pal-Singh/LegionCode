//go:build linux && amd64

package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

func runNamespaceInit() int {
	runtime.LockOSThread()
	// ExtraFiles are intentionally available only to the trusted init. A tool
	// exec must never inherit a root, namespace, creator-gate or receipt handle.
	for descriptor := 3; descriptor <= 38; descriptor++ {
		syscall.CloseOnExec(descriptor)
	}
	config := os.NewFile(3, "configuration")
	gate := os.NewFile(4, "creator-gate")
	status := os.NewFile(5, "init-status")
	workspace := os.NewFile(6, "held-workspace")
	if config == nil || gate == nil || status == nil || workspace == nil {
		return 125
	}
	reject := func() int {
		_ = json.NewEncoder(status).Encode(initMessage{Kind: "rejected", Code: "namespace_setup_unavailable"})
		return 125
	}
	groups, groupErr := syscall.Getgroups()
	if os.Getpid() != 1 || os.Getuid() != 0 || os.Geteuid() != 0 || os.Getgid() != 0 || groupErr != nil || len(groups) != 0 {
		return reject()
	}
	var input initRequest
	if decodeBounded(config, maxRequestBytes, &input) != nil {
		return reject()
	}
	_ = config.Close()
	// Read membership before pivot_root removes the host cgroup filesystem.
	// The untrusted process never receives a cgroup descriptor or mount.
	membership, membershipErr := os.ReadFile("/proc/self/cgroup")
	if !strings.HasPrefix(input.CgroupPath, commandCgroupPath) || membershipErr != nil || strings.TrimSpace(string(membership)) != "0::"+input.CgroupPath {
		return reject()
	}
	if setupFilesystem(input, workspace) != nil {
		return reject()
	}
	_ = workspace.Close()
	if setupPrivateLoopback() != nil || restrictPrivilege() != nil || installExecutionFilter() != nil {
		return reject()
	}
	if json.NewEncoder(status).Encode(initMessage{Kind: "prepared"}) != nil {
		return 125
	}
	permission, err := io.ReadAll(io.LimitReader(gate, 2))
	_ = gate.Close()
	if err != nil || len(permission) != 1 || permission[0] != 1 {
		return 125
	}
	command := exec.Command(input.Argv[0], input.Argv[1:]...)
	command.Dir = filepath.Join(input.Root, input.Cwd)
	command.Env = commandEnvironment(input.Environment)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	command.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{Uid: 1, Gid: 1, Groups: []uint32{}},
		Pdeathsig:  syscall.SIGKILL,
	}
	if err := command.Start(); err != nil {
		return reject()
	}
	err = command.Wait()
	exit := 0
	if err != nil {
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			exit = exited.ExitCode()
		} else {
			return 125
		}
	}
	if json.NewEncoder(status).Encode(initMessage{Kind: "foreground_exit", ExitCode: &exit}) != nil {
		return 125
	}
	// Returning from PID 1 invokes kernel namespace teardown. The outside owner
	// waits for that process; it does not infer closure from this message.
	return 0
}

func commandEnvironment(provided map[string]string) []string {
	values := []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/legion", "TMPDIR=/tmp", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"}
	for _, key := range []string{"NODE_ENV", "CI"} {
		if value, exists := provided[key]; exists {
			values = append(values, key+"="+value)
		}
	}
	return values
}

func setupFilesystem(input initRequest, workspace *os.File) error {
	if syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, "") != nil {
		return errors.New("mount_isolation_unavailable")
	}
	if syscall.Mount("none", input.RootFS, "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, "mode=0755,size=32m") != nil {
		return errors.New("private_root_unavailable")
	}
	rooted := func(path string) string { return filepath.Join(input.RootFS, strings.TrimPrefix(path, "/")) }
	for _, path := range []string{"/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt/legioncode/container-tools"} {
		if _, err := os.Stat(path); err != nil {
			if path == "/lib64" && os.IsNotExist(err) {
				continue
			}
			return errors.New("toolchain_unavailable")
		}
		if bindReadOnly(path, rooted(path)) != nil {
			return errors.New("readonly_toolchain_unavailable")
		}
	}
	for _, path := range []string{"/etc/ssl/certs", "/etc/ssl/openssl.cnf", "/etc/ld.so.cache"} {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		if bindReadOnly(path, rooted(path)) != nil {
			return errors.New("readonly_configuration_unavailable")
		}
	}
	for _, path := range []string{"/tmp", "/home/legion", "/proc", "/dev", "/dev/shm", "/etc", "/.oldroot"} {
		if os.MkdirAll(rooted(path), 0755) != nil {
			return errors.New("private_path_unavailable")
		}
	}
	for _, item := range []struct{ path, options string }{
		{"/tmp", "mode=1777,size=256m"}, {"/home/legion", "mode=0700,uid=1,gid=1,size=128m"},
		{"/dev", "mode=0755,size=1m"},
	} {
		if syscall.Mount("none", rooted(item.path), "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, item.options) != nil {
			return errors.New("private_temporary_unavailable")
		}
	}
	if os.MkdirAll(rooted("/dev/shm"), 01777) != nil ||
		syscall.Mount("none", rooted("/dev/shm"), "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, "mode=1777,size=64m") != nil {
		return errors.New("private_shared_memory_unavailable")
	}
	for _, name := range []string{"null", "zero", "random", "urandom"} {
		destination := rooted("/dev/" + name)
		file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0666)
		if err != nil {
			return errors.New("private_device_unavailable")
		}
		_ = file.Close()
		if syscall.Mount("/dev/"+name, destination, "", syscall.MS_BIND, "") != nil {
			return errors.New("private_device_unavailable")
		}
	}
	for link, target := range map[string]string{"fd": "/proc/self/fd", "stdin": "/proc/self/fd/0", "stdout": "/proc/self/fd/1", "stderr": "/proc/self/fd/2"} {
		if os.Symlink(target, rooted("/dev/"+link)) != nil {
			return errors.New("private_device_unavailable")
		}
	}
	if os.WriteFile(rooted("/etc/passwd"), []byte("root:x:0:0:root:/:/bin/false\nlegion:x:1:1:legion:/home/legion:/bin/sh\n"), 0644) != nil ||
		os.WriteFile(rooted("/etc/group"), []byte("root:x:0:\nlegion:x:1:\n"), 0644) != nil ||
		os.WriteFile(rooted("/etc/nsswitch.conf"), []byte("passwd: files\ngroup: files\nhosts: files\n"), 0644) != nil ||
		os.WriteFile(rooted("/etc/hosts"), []byte("127.0.0.1 localhost\n::1 localhost\n"), 0644) != nil {
		return errors.New("private_configuration_unavailable")
	}
	destination := rooted(input.Root)
	if os.MkdirAll(destination, 0755) != nil {
		return errors.New("workspace_mount_unavailable")
	}
	if syscall.Mount("/proc/self/fd/6", destination, "", syscall.MS_BIND, "") != nil ||
		syscall.Mount("", destination, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_NOSUID|syscall.MS_NODEV, "") != nil {
		return errors.New("workspace_mount_unavailable")
	}
	if mountProtectedMetadata(input) != nil {
		return errors.New("metadata_mount_unavailable")
	}
	if syscall.Mount("proc", rooted("/proc"), "proc", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC|syscall.MS_RDONLY, "") != nil {
		return errors.New("private_proc_unavailable")
	}
	// A chroot alone is insufficient. Detach the old mount root completely and
	// close the only outside directory descriptor before admitting user code.
	if syscall.PivotRoot(input.RootFS, rooted("/.oldroot")) != nil || os.Chdir("/") != nil ||
		syscall.Unmount("/.oldroot", syscall.MNT_DETACH) != nil || os.Remove("/.oldroot") != nil {
		return errors.New("old_root_detachment_unavailable")
	}
	return nil
}

func bindReadOnly(source, target string) error {
	resolved, err := filepath.EvalSymlinks(source)
	if err != nil {
		return err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return err
	}
	identity, ok := info.Sys().(*syscall.Stat_t)
	if !ok || identity.Uid != 0 || info.Mode().Perm()&0022 != 0 {
		return errors.New("untrusted_toolchain")
	}
	if info.IsDir() {
		if os.MkdirAll(target, 0755) != nil {
			return errors.New("readonly_mount_unavailable")
		}
	} else {
		if os.MkdirAll(filepath.Dir(target), 0755) != nil {
			return errors.New("readonly_mount_unavailable")
		}
		file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err != nil {
			return err
		}
		_ = file.Close()
	}
	// Non-recursive bind deliberately does not import nested host mounts.
	if syscall.Mount(resolved, target, "", syscall.MS_BIND, "") != nil ||
		syscall.Mount("", target, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY|syscall.MS_NOSUID|syscall.MS_NODEV, "") != nil {
		return errors.New("readonly_mount_unavailable")
	}
	return nil
}

func setupPrivateLoopback() error {
	descriptor, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(descriptor)
	var request [40]byte
	copy(request[:], "lo")
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(descriptor), 0x8913, uintptr(unsafe.Pointer(&request[0]))); errno != 0 {
		return errno
	}
	flags := (*uint16)(unsafe.Pointer(&request[16]))
	*flags |= 1
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(descriptor), 0x8914, uintptr(unsafe.Pointer(&request[0]))); errno != 0 {
		return errno
	}
	return nil
}

func restrictPrivilege() error {
	if _, _, err := syscall.RawSyscall6(syscall.SYS_PRCTL, 28, 0, 0, 0, 0, 0); err != 0 {
		return err
	} // PR_SET_SECUREBITS
	if _, _, err := syscall.RawSyscall6(syscall.SYS_PRCTL, 8, 0, 0, 0, 0, 0); err != 0 {
		return err
	} // PR_SET_KEEPCAPS
	if _, _, err := syscall.RawSyscall6(syscall.SYS_PRCTL, 47, 4, 0, 0, 0, 0); err != 0 {
		return err
	} // PR_CAP_AMBIENT_CLEAR_ALL
	last, err := os.ReadFile("/proc/sys/kernel/cap_last_cap")
	if err != nil {
		return err
	}
	maximum, err := strconv.Atoi(strings.TrimSpace(string(last)))
	if err != nil || maximum < 0 || maximum > 63 {
		return errors.New("capability_set_unavailable")
	}
	for capability := 0; capability <= maximum; capability++ {
		if _, _, err := syscall.RawSyscall6(syscall.SYS_PRCTL, 24, uintptr(capability), 0, 0, 0, 0); err != 0 {
			return err
		} // PR_CAPBSET_DROP
	}
	if _, _, err := syscall.RawSyscall6(syscall.SYS_PRCTL, 38, 1, 0, 0, 0, 0); err != 0 {
		return err
	} // PR_SET_NO_NEW_PRIVS
	return nil
}

func openHeldWorkspace(path string, expected rootIdentity) (*os.File, error) {
	descriptor, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, component := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		next, openErr := syscall.Openat(descriptor, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		_ = syscall.Close(descriptor)
		if openErr != nil {
			return nil, openErr
		}
		descriptor = next
	}
	var info syscall.Stat_t
	if syscall.Fstat(descriptor, &info) != nil || uint64(info.Dev) != expected.Device || info.Ino != expected.Inode ||
		info.Uid != toolHostUID || info.Gid != toolHostGID {
		_ = syscall.Close(descriptor)
		return nil, errors.New("workspace_identity_unavailable")
	}
	return os.NewFile(uintptr(descriptor), "held-workspace"), nil
}

func verifyHeldCwd(workspace *os.File, path string) error {
	descriptor, err := syscall.Dup(int(workspace.Fd()))
	if err != nil {
		return err
	}
	syscall.CloseOnExec(descriptor)
	defer func() { _ = syscall.Close(descriptor) }()
	if path == "." {
		return nil
	}
	for _, component := range strings.Split(path, "/") {
		next, openErr := syscall.Openat(descriptor, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if openErr != nil {
			return errors.New("cwd_identity_unavailable")
		}
		_ = syscall.Close(descriptor)
		descriptor = next
	}
	return nil
}

func preparePrivateDirectory(path string) error {
	descriptor, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer func() { _ = syscall.Close(descriptor) }()
	for _, component := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		next, openErr := syscall.Openat(descriptor, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if openErr == syscall.ENOENT {
			if syscall.Mkdirat(descriptor, component, 0700) != nil {
				return errors.New("private_directory_unavailable")
			}
			next, openErr = syscall.Openat(descriptor, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		}
		if openErr != nil {
			return errors.New("private_directory_unavailable")
		}
		var identity syscall.Stat_t
		if syscall.Fstat(next, &identity) != nil || identity.Uid != 0 || identity.Mode&0022 != 0 {
			_ = syscall.Close(next)
			return errors.New("private_directory_unavailable")
		}
		_ = syscall.Close(descriptor)
		descriptor = next
	}
	return nil
}
