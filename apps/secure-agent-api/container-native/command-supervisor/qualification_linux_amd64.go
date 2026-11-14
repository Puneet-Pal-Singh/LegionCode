//go:build linux && amd64

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	if (mode != "--qualification-payload" && mode != "--qualification-stop-payload") || verifyQualificationRestrictions() != nil {
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
	if mode == "--qualification-stop-payload" {
		for {
			time.Sleep(time.Second)
		}
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
	var filesystem syscall.Statfs_t
	if syscall.Statfs("/usr", &filesystem) != nil || filesystem.Flags&1 /* ST_RDONLY */ == 0 {
		return syscall.EPERM
	}
	fd, err := syscall.Open("/usr/local/libexec/legioncode-command-supervisor", syscall.O_WRONLY|syscall.O_CLOEXEC, 0)
	if err == nil {
		_ = syscall.Close(fd)
		return syscall.EPERM
	}
	if err != syscall.EROFS && err != syscall.EACCES && err != syscall.EPERM {
		return err
	}
	fd, err = syscall.Open("/home/sandbox/outside-qualification-workspace", syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC, 0600)
	if err == nil {
		_ = syscall.Close(fd)
		return syscall.EPERM
	}
	if err != syscall.EROFS && err != syscall.EACCES && err != syscall.EPERM {
		return err
	}
	if fd, err := syscall.Open("/run/legioncode/native-commands", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0); err == nil {
		_ = syscall.Close(fd)
		return syscall.EPERM
	}
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

// This recipe uses an exclusive disposable nonrepository directory. It does not
// manufacture Git metadata or qualify the separate product repository contract.
type qualificationFixture struct {
	Root          string       `json:"root"`
	Identity      rootIdentity `json:"identity"`
	SandboxBootID string       `json:"sandboxBootId"`
	Fingerprint   string       `json:"fingerprint"`
	HelperSha256  string       `json:"helperSha256"`
}
type qualificationInput struct {
	Binding      resourceSetupBinding  `json:"binding"`
	Nonce        string                `json:"nonce"`
	Fixture      *qualificationFixture `json:"fixture,omitempty"`
	ControlToken string                `json:"controlToken,omitempty"`
}

func qualificationFixturePath(nonce string) string {
	return "/home/sandbox/checkouts/operator-qualification-" + nonce
}
func fixtureFingerprint(root rootIdentity, boot, nonce, authority string) string {
	data, _ := json.Marshal(struct {
		Root                   rootIdentity
		Boot, Nonce, Authority string
	}{root, boot, nonce, authority})
	sum := sha256.Sum256(data)
	return "native-qualification-fixture-v1:" + hex.EncodeToString(sum[:])
}
func qualificationOperation(mode string) (resultErr error) {
	if requireToolIdentity() != nil {
		return errors.New("protected_owner_required")
	}
	var input qualificationInput
	if decodeBounded(os.Stdin, maxRequestBytes, &input) != nil || !hexadecimal.MatchString(input.Nonce) || validateResourceSetupIdentity(input.Binding) != nil {
		return errors.New("invalid_qualification_scope")
	}
	if mode != "--observe-qualification-fixture" && validateResourceSetupBinding(input.Binding) != nil {
		return errors.New("qualification_grant_expired")
	}
	bootBytes, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return err
	}
	boot := strings.TrimSpace(string(bootBytes))
	rootPath := qualificationFixturePath(input.Nonce)
	if mode == "--prepare-qualification-fixture" {
		parent, err := openQualificationParent(input.Binding.ExpiresAt)
		if err != nil {
			return err
		}
		defer parent.Close()
		if input.Binding.ExpiresAt <= time.Now().UnixMilli() {
			return errors.New("qualification_grant_expired")
		}
		name := "operator-qualification-" + input.Nonce
		if syscall.Mkdirat(int(parent.Fd()), name, 0700) != nil {
			return errors.New("qualification_fixture_collision")
		}
		fd, err := syscall.Openat(int(parent.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if err != nil {
			return err
		}
		file := os.NewFile(uintptr(fd), "owned-qualification-fixture")
		defer file.Close()
		if syscall.Fchown(fd, toolHostUID, toolHostGID) != nil {
			return errors.New("qualification_fixture_owner_unavailable")
		}
		var info syscall.Stat_t
		if syscall.Fstat(fd, &info) != nil {
			return errors.New("qualification_fixture_identity_unavailable")
		}
		root := rootIdentity{uint64(info.Dev), info.Ino}
		helperHash, err := resourceHelperHash()
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(qualificationFixture{rootPath, root, boot, fixtureFingerprint(root, boot, input.Nonce, input.Binding.AuthorityDigest), helperHash})
	}
	if input.Fixture == nil || input.Fixture.Root != rootPath || input.Fixture.SandboxBootID != boot || input.Fixture.Fingerprint != fixtureFingerprint(input.Fixture.Identity, boot, input.Nonce, input.Binding.AuthorityDigest) {
		return errors.New("qualification_fixture_changed")
	}
	root, err := openHeldWorkspace(rootPath, input.Fixture.Identity)
	if err != nil {
		return err
	}
	defer func() {
		if err := root.Close(); resultErr == nil && err != nil {
			resultErr = errors.New("qualification_root_close_unconfirmed")
		}
	}()
	if mode == "--observe-qualification-fixture" {
		return observeQualificationWriters(input, root)
	}
	if !hexadecimal.MatchString(input.ControlToken) {
		return errors.New("qualification_control_required")
	}
	request := request{Version: protocolVersion, Binding: binding{Qualification: &input.Binding, Nonce: input.Nonce}, ControlToken: input.ControlToken,
		Root: rootPath, ExpectedRoot: input.Fixture.Identity, ExpectedBootID: boot, Cwd: ".",
		Argv:        []string{"/usr/local/libexec/legioncode-command-supervisor", "--qualification-stop-payload", input.Nonce},
		Environment: nil, TimeoutMS: 60000, OutputLimit: 64 * 1024, Limits: resourceLimits{512 * 1024 * 1024, 128, 100000, 100000},
		Metadata: metadataProtection{Identity: input.Fixture.Fingerprint}}
	if validateRequest(request) != nil {
		return errors.New("invalid_qualification_recipe")
	}
	return serveCommand(request)
}
func openQualificationParent(expiresAt int64) (*os.File, error) {
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, name := range []string{"home", "sandbox", "checkouts"} {
		next, err := syscall.Openat(fd, name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if err == syscall.ENOENT && name != "home" {
			if expiresAt <= time.Now().UnixMilli() || syscall.Mkdirat(fd, name, 0755) != nil {
				_ = syscall.Close(fd)
				return nil, errors.New("qualification_parent_unavailable")
			}
			next, err = syscall.Openat(fd, name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		}
		_ = syscall.Close(fd)
		if err != nil {
			return nil, err
		}
		fd = next
		var info syscall.Stat_t
		if syscall.Fstat(fd, &info) != nil || info.Uid != 0 || info.Mode&0022 != 0 {
			_ = syscall.Close(fd)
			return nil, errors.New("protected_qualification_parent_required")
		}
	}
	return os.NewFile(uintptr(fd), "held-qualification-parent"), nil
}
func validateQualificationFixture(input request) error {
	if input.Binding.Qualification == nil || input.Root != qualificationFixturePath(input.Binding.Nonce) || input.Cwd != "." || len(input.Metadata.Entries) != 0 ||
		input.Metadata.Identity != fixtureFingerprint(input.ExpectedRoot, input.ExpectedBootID, input.Binding.Nonce, input.Binding.Qualification.AuthorityDigest) ||
		len(input.Argv) != 3 || input.Argv[0] != "/usr/local/libexec/legioncode-command-supervisor" || input.Argv[1] != "--qualification-stop-payload" || input.Argv[2] != input.Binding.Nonce {
		return errors.New("fixed_qualification_recipe_required")
	}
	return nil
}
func observeQualificationWriters(input qualificationInput, root *os.File) (resultErr error) {
	name := ".legioncode-command-qualification-" + input.Nonce
	fd, err := syscall.Openat(int(root.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer func() {
		if err := syscall.Close(fd); resultErr == nil && err != nil {
			resultErr = errors.New("qualification_marker_directory_close_unconfirmed")
		}
	}()
	// Supplementary read stability only. It never replaces namespace/cgroup
	// closure or the supervisor's actual original EOF and process-exit evidence.
	type marker struct {
		Name     string       `json:"name"`
		Identity rootIdentity `json:"identity"`
		Bytes    int64        `json:"bytes"`
		Sha256   string       `json:"sha256"`
	}
	read := func() ([]marker, error) {
		values := []marker{}
		for _, leaf := range []string{"detached", "double-fork", "clone-parent"} {
			fileFD, err := syscall.Openat(fd, leaf, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
			if err != nil {
				return nil, err
			}
			file := os.NewFile(uintptr(fileFD), "held-qualification-marker")
			var info syscall.Stat_t
			if syscall.Fstat(fileFD, &info) != nil || info.Mode&syscall.S_IFMT != syscall.S_IFREG || info.Nlink != 1 || info.Uid != toolHostUID || info.Size <= 0 || info.Size > 16384 {
				_ = file.Close()
				return nil, errors.New("qualification_marker_changed")
			}
			data, err := io.ReadAll(io.LimitReader(file, 16385))
			closeErr := file.Close()
			if err != nil || closeErr != nil || int64(len(data)) != info.Size {
				return nil, errors.New("qualification_marker_unsettled")
			}
			hash := sha256.Sum256(data)
			values = append(values, marker{leaf, rootIdentity{uint64(info.Dev), info.Ino}, info.Size, hex.EncodeToString(hash[:])})
		}
		return values, nil
	}
	before, err := read()
	if err != nil {
		return err
	}
	started := time.Now()
	time.Sleep(250 * time.Millisecond)
	after, err := read()
	if err != nil {
		return err
	}
	left, _ := json.Marshal(before)
	right, _ := json.Marshal(after)
	if string(left) != string(right) {
		return errors.New("qualification_writers_still_active")
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		Binding          resourceSetupBinding `json:"binding"`
		Nonce            string               `json:"nonce"`
		Fixture          qualificationFixture `json:"fixture"`
		Markers          []marker             `json:"markers"`
		StableIntervalMS int64                `json:"stableIntervalMs"`
	}{input.Binding, input.Nonce, *input.Fixture, after, time.Since(started).Milliseconds()})
}
