//go:build linux && amd64

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Fixed, explicitly admitted qualification workload. It leaves three bounded
// marker files in its disposable checkout so an outside observer can verify
// that writes stop after namespace closure. It never deletes user content.
func runQualificationPayload(mode, nonce string) int {
	if !hexadecimal.MatchString(nonce) || os.Getuid() != 1 || os.Geteuid() != 1 || os.Getgid() != 1 || os.Getpid() == 1 {
		return 125
	}
	directory := ".legioncode-command-qualification-" + nonce
	if mode == "--qualification-detached" {
		return qualificationWriter(directory, "detached")
	}
	if mode == "--qualification-double-child" {
		return qualificationWriter(directory, "double-fork")
	}
	if mode == "--qualification-parent-child" {
		return qualificationWriter(directory, "clone-parent")
	}
	if mode == "--qualification-spawner" {
		return startQualificationChild("--qualification-double-child", nonce, 0)
	}
	if mode != "--qualification-payload" || verifyQualificationRestrictions() != nil {
		return 125
	}
	if os.Mkdir(directory, 0700) != nil {
		return 125
	}
	if startQualificationChild("--qualification-detached", nonce, 0) != 0 {
		return 125
	}
	executable, err := os.Executable()
	if err != nil {
		return 125
	}
	spawner := exec.Command(executable, "--qualification-spawner", nonce)
	spawner.Env = commandEnvironment(nil)
	if spawner.Run() != nil || startQualificationChild("--qualification-parent-child", nonce, syscall.CLONE_PARENT) != 0 {
		return 125
	}
	markers := []string{"detached", "double-fork", "clone-parent"}
	deadline := time.Now().Add(5 * time.Second)
	for _, marker := range markers {
		for {
			info, err := os.Stat(filepath.Join(directory, marker))
			if err == nil && info.Size() > 0 {
				break
			}
			if time.Now().After(deadline) {
				return 125
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	// This means only that the fixed payload ran. The outside owner must check
	// the actual closed receipt, output EOF, stopped marker writes and preserved
	// checkout before assigning any runtime capability.
	if json.NewEncoder(os.Stdout).Encode(struct {
		Payload string   `json:"payload"`
		Markers []string `json:"markers"`
	}{"qualification_children_started", markers}) != nil {
		return 125
	}
	return 0
}

func startQualificationChild(mode, nonce string, flags uintptr) int {
	executable, err := os.Executable()
	if err != nil {
		return 125
	}
	child := exec.Command(executable, mode, nonce)
	child.Env = commandEnvironment(nil)
	child.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Cloneflags: flags}
	// os/exec supplies /dev/null for nil streams. These descendants deliberately
	// close the original pipes: output EOF alone must not be mistaken for exit.
	if child.Start() != nil || child.Process.Release() != nil {
		return 125
	}
	return 0
}

func qualificationWriter(directory, name string) int {
	file, err := os.OpenFile(filepath.Join(directory, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return 125
	}
	defer file.Close()
	// Bounded bytes even if a failed platform boundary leaves this fixture alive.
	// Remaining alive still fails the outside observer's lifetime qualification.
	for index := 0; index < 400; index++ {
		if _, err := fmt.Fprintln(file, index); err != nil {
			return 125
		}
		if file.Sync() != nil {
			return 125
		}
		time.Sleep(25 * time.Millisecond)
	}
	for {
		time.Sleep(time.Hour)
	} // Must be killed with its namespace.
}

func verifyQualificationRestrictions() error {
	groups, err := syscall.Getgroups()
	if err != nil || len(groups) != 0 {
		return syscall.EPERM
	}
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return err
	}
	for _, field := range []string{"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"} {
		if !strings.Contains(string(status), field+":\t0000000000000000") {
			return syscall.EPERM
		}
	}
	if !strings.Contains(string(status), "NoNewPrivs:\t1") || !strings.Contains(string(status), "Seccomp:\t2") {
		return syscall.EPERM
	}
	if syscall.Setuid(0) != syscall.EPERM || syscall.Unshare(syscall.CLONE_NEWUSER) != syscall.EPERM || syscall.Chroot("/") != syscall.EPERM {
		return syscall.EPERM
	}
	descriptor, socketErr := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if socketErr == nil {
		_ = syscall.Close(descriptor)
		return syscall.EPERM
	}
	if socketErr != syscall.EPERM {
		return socketErr
	}
	descriptor, err = syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(descriptor)
	// Private loopback has no outside control listener. A successful connection
	// would be a real control-plane escape, regardless of process cleanup.
	if syscall.Connect(descriptor, &syscall.SockaddrInet4{Port: 3101, Addr: [4]byte{127, 0, 0, 1}}) != syscall.ECONNREFUSED {
		return syscall.EPERM
	}
	return nil
}
