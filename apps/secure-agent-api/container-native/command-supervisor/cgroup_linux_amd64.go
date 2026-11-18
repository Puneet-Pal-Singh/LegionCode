//go:build linux && amd64

package main

import (
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const cgroupBoundary = "/sys/fs/cgroup/legioncode-native"
const commandCgroupPath = "/legioncode-native/commands/"
const controlMemoryReserve = 128 * 1024 * 1024

// This is a handle to the existing physical Sandbox owner's delegated kernel
// resource, not a second checkout lease. The owner must provision this hierarchy
// at runtime; an image UID, manifest label or writable ordinary directory is not
// an acceptable substitute for a real delegated cgroup-v2 domain.
type commandDomain struct {
	file     *os.File
	parent   *os.File
	name     string
	identity rootIdentity
	limits   resourceLimits
}

func prepareCommandDomain(input request) (*commandDomain, error) {
	boundary, err := openProtectedCgroup(cgroupBoundary)
	if err != nil {
		return nil, err
	}
	defer boundary.Close()
	control, err := openProtectedCgroup(cgroupBoundary + "/control")
	if err != nil {
		return nil, err
	}
	defer control.Close()
	commands, err := openProtectedCgroup(cgroupBoundary + "/commands")
	if err != nil {
		return nil, err
	}
	failed := true
	defer func() {
		if failed {
			_ = commands.Close()
		}
	}()
	self, err := os.ReadFile("/proc/self/cgroup")
	if err != nil || strings.TrimSpace(string(self)) != "0::/legioncode-native/control" {
		return nil, errors.New("protected_control_domain_required")
	}
	for _, directory := range []*os.File{boundary, control, commands} {
		kind, readErr := readCgroupFile(directory, "cgroup.type")
		if readErr != nil || kind != "domain" {
			return nil, errors.New("resource_domain_unavailable")
		}
	}
	for _, directory := range []*os.File{boundary, commands} {
		controllers, readErr := readCgroupFile(directory, "cgroup.subtree_control")
		if readErr != nil || !hasControllers(controllers) {
			return nil, errors.New("resource_controllers_unavailable")
		}
		processes, readErr := readCgroupFile(directory, "cgroup.procs")
		if readErr != nil || processes != "" {
			return nil, errors.New("resource_delegation_not_empty")
		}
	}
	if verifyResourceBudgets(boundary, control, commands, input.Limits) != nil {
		return nil, errors.New("protected_resource_budget_required")
	}
	// A nonce is created once by the existing DO intent owner. Reopening or
	// adopting an old cgroup as a new command is prohibited, including if empty.
	if syscall.Mkdirat(int(commands.Fd()), input.Binding.Nonce, 0700) != nil {
		return nil, errors.New("resource_intent_already_exists")
	}
	childFD, err := syscall.Openat(int(commands.Fd()), input.Binding.Nonce,
		syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("resource_domain_unavailable")
	}
	domain := &commandDomain{file: os.NewFile(uintptr(childFD), "command-domain"), parent: commands,
		name: input.Binding.Nonce, limits: input.Limits}
	configured := false
	defer func() {
		if !configured {
			_ = domain.removeEmpty()
			_ = domain.file.Close()
		}
	}()
	var identity syscall.Stat_t
	if syscall.Fstat(childFD, &identity) != nil || identity.Uid != 0 || identity.Mode&0077 != 0 {
		return nil, errors.New("resource_identity_unavailable")
	}
	domain.identity = rootIdentity{Device: uint64(identity.Dev), Inode: identity.Ino}
	settings := [][2]string{
		{"memory.max", strconv.FormatUint(input.Limits.MemoryBytes, 10)},
		{"memory.swap.max", "0"}, {"memory.oom.group", "1"},
		{"pids.max", strconv.FormatUint(input.Limits.Pids, 10)},
		{"cpu.max", strconv.FormatUint(input.Limits.CPUQuotaMicros, 10) + " " + strconv.FormatUint(input.Limits.CPUPeriodMicros, 10)},
	}
	for _, item := range settings {
		if writeCgroupFile(domain.file, item[0], item[1]) != nil {
			return nil, errors.New("resource_enforcement_unavailable")
		}
		actual, readErr := readCgroupFile(domain.file, item[0])
		if readErr != nil || actual != item[1] {
			return nil, errors.New("resource_enforcement_unavailable")
		}
	}
	// Require the kernel kill and population interfaces before any process birth.
	killFD, err := openCgroupFile(domain.file, "cgroup.kill", syscall.O_WRONLY)
	if err != nil {
		return nil, errors.New("resource_termination_unavailable")
	}
	_ = syscall.Close(killFD)
	empty, err := domain.empty()
	if err != nil || !empty {
		return nil, errors.New("resource_domain_not_empty")
	}
	configured, failed = true, false
	return domain, nil
}

func hasControllers(value string) bool {
	available := map[string]bool{}
	for _, field := range strings.Fields(value) {
		available[field] = true
	}
	return available["cpu"] && available["memory"] && available["pids"]
}

func verifyResourceBudgets(boundary, control, commands *os.File, requested resourceLimits) error {
	// An OOM at an ancestor must not turn the command's killable subtree into
	// an instruction to kill its protected control sibling as one OOM group.
	for _, directory := range []*os.File{boundary, control} {
		value, err := readCgroupFile(directory, "memory.oom.group")
		if err != nil || value != "0" {
			return errors.New("protected_control_oom_scope_required")
		}
	}
	boundaryMemory, err := finiteLimit(boundary, "memory.max")
	if err != nil {
		return err
	}
	controlMemory, err := finiteLimit(control, "memory.max")
	if err != nil || controlMemory < controlMemoryReserve {
		return errors.New("control_memory_budget_required")
	}
	commandMemory, err := finiteLimit(commands, "memory.max")
	if err != nil || commandMemory < requested.MemoryBytes || commandMemory > boundaryMemory || controlMemory > boundaryMemory-commandMemory {
		return errors.New("memory_budget_unavailable")
	}
	minimum, err := finiteLimit(control, "memory.min")
	if err != nil || minimum < controlMemory {
		return errors.New("control_memory_reservation_required")
	}
	minimum, err = finiteLimit(boundary, "memory.min")
	if err != nil || minimum < controlMemory {
		return errors.New("control_memory_reservation_required")
	}
	swap, err := readCgroupFile(commands, "memory.swap.max")
	if err != nil || swap != "0" {
		return errors.New("command_swap_must_be_disabled")
	}
	boundaryPids, err := finiteLimit(boundary, "pids.max")
	if err != nil {
		return err
	}
	controlPids, err := finiteLimit(control, "pids.max")
	if err != nil || controlPids < 64 {
		return errors.New("control_process_budget_required")
	}
	commandPids, err := finiteLimit(commands, "pids.max")
	if err != nil || commandPids < requested.Pids || commandPids > boundaryPids || controlPids > boundaryPids-commandPids {
		return errors.New("process_budget_unavailable")
	}
	// The hierarchy must fit inside actual guest memory with explicit room for
	// kernel/platform work outside this runtime-owned boundary. A finite cgroup
	// limit larger than the VM would otherwise still permit a guest-wide OOM.
	memory, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return err
	}
	var total uint64
	for _, line := range strings.Split(string(memory), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 3 && fields[0] == "MemTotal:" && fields[2] == "kB" {
			total, err = strconv.ParseUint(fields[1], 10, 53)
			if err != nil {
				return err
			}
			total *= 1024
		}
	}
	if total <= controlMemoryReserve || boundaryMemory > total-controlMemoryReserve {
		return errors.New("guest_memory_budget_unavailable")
	}
	return nil
}

func finiteLimit(directory *os.File, name string) (uint64, error) {
	value, err := readCgroupFile(directory, name)
	if err != nil {
		return 0, err
	}
	parsed, err := strconv.ParseUint(value, 10, 53)
	if err != nil || parsed == 0 {
		return 0, errors.New("finite_resource_limit_required")
	}
	return parsed, nil
}

func openProtectedCgroup(path string) (*os.File, error) {
	descriptor, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, component := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		next, openErr := syscall.Openat(descriptor, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		_ = syscall.Close(descriptor)
		if openErr != nil {
			return nil, errors.New("protected_cgroup_required")
		}
		descriptor = next
		var info syscall.Stat_t
		if syscall.Fstat(descriptor, &info) != nil || info.Uid != 0 || info.Mode&0022 != 0 {
			_ = syscall.Close(descriptor)
			return nil, errors.New("protected_cgroup_required")
		}
	}
	var filesystem syscall.Statfs_t
	if syscall.Fstatfs(descriptor, &filesystem) != nil || uint64(filesystem.Type) != 0x63677270 {
		_ = syscall.Close(descriptor)
		return nil, errors.New("cgroup_v2_required")
	}
	return os.NewFile(uintptr(descriptor), "protected-cgroup"), nil
}

func openCgroupFile(directory *os.File, name string, mode int) (int, error) {
	fd, err := syscall.Openat(int(directory.Fd()), name, mode|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	var identity syscall.Stat_t
	if syscall.Fstat(fd, &identity) != nil || identity.Uid != 0 || identity.Mode&0022 != 0 {
		_ = syscall.Close(fd)
		return -1, errors.New("protected_cgroup_control_required")
	}
	return fd, nil
}

func readCgroupFile(directory *os.File, name string) (string, error) {
	fd, err := openCgroupFile(directory, name, syscall.O_RDONLY)
	if err != nil {
		return "", err
	}
	file := os.NewFile(uintptr(fd), "cgroup-value")
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(data) > 4096 {
		return "", errors.New("cgroup_value_unavailable")
	}
	return strings.TrimSpace(string(data)), nil
}

func writeCgroupFile(directory *os.File, name, value string) error {
	fd, err := openCgroupFile(directory, name, syscall.O_WRONLY)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	count, err := syscall.Write(fd, []byte(value))
	if err != nil || count != len(value) {
		return errors.New("cgroup_write_unconfirmed")
	}
	return nil
}

func (domain *commandDomain) empty() (bool, error) {
	value, err := readCgroupFile(domain.file, "cgroup.events")
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(value, "\n") {
		if line == "populated 0" {
			return true, nil
		}
		if line == "populated 1" {
			return false, nil
		}
	}
	return false, errors.New("cgroup_population_unavailable")
}

func (domain *commandDomain) kill() error { return writeCgroupFile(domain.file, "cgroup.kill", "1") }

// Never delete an unknown or populated resource. Both the held directory and
// its current parent entry must still identify this exact command generation.
func (domain *commandDomain) removeEmpty() error {
	empty, err := domain.empty()
	if err != nil || !empty {
		return errors.New("resource_closure_unconfirmed")
	}
	fd, err := syscall.Openat(int(domain.parent.Fd()), domain.name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	var info syscall.Stat_t
	if syscall.Fstat(fd, &info) != nil || uint64(info.Dev) != domain.identity.Device || info.Ino != domain.identity.Inode {
		return errors.New("resource_identity_changed")
	}
	name, err := syscall.BytePtrFromString(domain.name)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall(syscall.SYS_UNLINKAT, domain.parent.Fd(), uintptr(unsafe.Pointer(name)), 0x200 /* AT_REMOVEDIR */)
	if errno != 0 {
		return errno
	}
	return nil
}
