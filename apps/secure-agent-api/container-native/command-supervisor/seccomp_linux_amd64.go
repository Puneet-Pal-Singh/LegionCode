//go:build linux && amd64

package main

import (
	"errors"
	"runtime"
	"syscall"
	"unsafe"
)

type socketFilter struct {
	Code   uint16
	JT, JF uint8
	K      uint32
}
type filterProgram struct {
	Length uint16
	Filter *socketFilter
}

const (
	bpfLoadWordAbsolute = 0x20
	bpfJumpEqual        = 0x15
	bpfJumpBitsSet      = 0x45
	bpfReturn           = 0x06
	seccompAllow        = 0x7fff0000
	seccompErrno        = 0x00050000
	seccompKillProcess  = 0x80000000
)

func installExecutionFilter() error {
	// Fixed Linux/amd64 ABI. An x32 or other ABI must not reinterpret the syscall
	// argument filters. No architecture or seccomp failure is a fallback path.
	filters := []socketFilter{
		{Code: bpfLoadWordAbsolute, K: 4},
		{Code: bpfJumpEqual, JT: 1, K: 0xc000003e},
		{Code: bpfReturn, K: seccompKillProcess},
		{Code: bpfLoadWordAbsolute, K: 0},
		{Code: bpfJumpBitsSet, JF: 1, K: 0x40000000},
		{Code: bpfReturn, K: seccompKillProcess},
	}
	// Block namespace/privileged escape surfaces, parent process inspection,
	// cross-process descriptor borrowing, and io_uring's alternate socket API.
	for _, number := range []uint32{101, 155, 161, 165, 166, 169, 206, 207, 208, 209, 210, 246, 248, 249, 250, 272, 298, 303, 304, 308, 310, 311, 320, 321, 323, 425, 426, 427, 438} {
		filters = append(filters, socketFilter{Code: bpfJumpEqual, JF: 1, K: number}, socketFilter{Code: bpfReturn, K: seccompErrno | uint32(syscall.EPERM)})
	}
	// clone3 stores flags behind a pointer, which classic seccomp cannot inspect.
	// ENOSYS permits libc's normal clone fallback; incompatible runtimes must fail
	// qualification rather than silently losing this restriction.
	filters = append(filters, socketFilter{Code: bpfJumpEqual, JF: 1, K: 435}, socketFilter{Code: bpfReturn, K: seccompErrno | uint32(syscall.ENOSYS)})
	filters = append(filters,
		// socket(): only private-netns IPv4/IPv6. Pathname AF_UNIX sockets may
		// otherwise delegate an FD/command to a process outside the PID namespace.
		socketFilter{Code: bpfJumpEqual, JF: 5, K: 41},
		socketFilter{Code: bpfLoadWordAbsolute, K: 16},
		socketFilter{Code: bpfJumpEqual, JT: 2, K: syscall.AF_INET},
		socketFilter{Code: bpfJumpEqual, JT: 1, K: syscall.AF_INET6},
		socketFilter{Code: bpfReturn, K: seccompErrno | uint32(syscall.EPERM)},
		socketFilter{Code: bpfReturn, K: seccompAllow},
		// socketpair(): anonymous IPC remains possible between namespace members;
		// no endpoint exists in an outside process or renderer.
		socketFilter{Code: bpfJumpEqual, JF: 4, K: 53},
		socketFilter{Code: bpfLoadWordAbsolute, K: 16},
		socketFilter{Code: bpfJumpEqual, JT: 1, K: syscall.AF_UNIX},
		socketFilter{Code: bpfReturn, K: seccompErrno | uint32(syscall.EPERM)},
		socketFilter{Code: bpfReturn, K: seccompAllow},
		// clone(): permit ordinary threads/forks, including CLONE_PARENT inside
		// this PID namespace, while denying all creation of further namespaces.
		socketFilter{Code: bpfJumpEqual, JF: 4, K: 56},
		socketFilter{Code: bpfLoadWordAbsolute, K: 16},
		socketFilter{Code: bpfJumpBitsSet, JF: 1, K: 0x7e020000},
		socketFilter{Code: bpfReturn, K: seccompErrno | uint32(syscall.EPERM)},
		socketFilter{Code: bpfReturn, K: seccompAllow},
		socketFilter{Code: bpfReturn, K: seccompAllow},
	)
	program := filterProgram{Length: uint16(len(filters)), Filter: &filters[0]}
	// Synchronize every existing Go runtime thread. Per-thread installation is
	// insufficient because os/exec and future threads inherit their creator.
	value, _, errno := syscall.RawSyscall(317, 1, 1, uintptr(unsafe.Pointer(&program))) // SECCOMP_SET_MODE_FILTER, TSYNC
	runtime.KeepAlive(filters)
	if errno != 0 {
		return errno
	}
	// A nonzero TSYNC return identifies an unsynchronized thread. The syscall
	// return must also be checked, rather than treating errno alone as success.
	if value != 0 {
		return errors.New("seccomp_thread_sync_unavailable")
	}
	return verifyFilterInstalled()
}

func verifyFilterInstalled() error {
	value, _, errno := syscall.RawSyscall6(syscall.SYS_PRCTL, 21, 0, 0, 0, 0, 0) // PR_GET_SECCOMP
	if errno != 0 || value != 2 {
		return errors.New("seccomp_unavailable")
	}
	return nil
}
