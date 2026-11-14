//go:build linux && amd64

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const resourcePolicy = "linux-pid-namespace-cgroup-v2-512m-v1"
const resourceBoundaryMemory = 640 * 1024 * 1024
const resourceCommandMemory = 512 * 1024 * 1024
const resourceBoundaryPids = 192
const resourceControlPids = 64
const resourceCommandPids = 128

// This private setup binding deliberately has no synthetic conversation Turn.
// The protected server caller must authorize the complete persisted physical
// owner audit and creator freeze before invoking this fixed operation. Digests
// identify that frozen authority; they are not bearer credentials or proof that
// the caller owns a path. Conversation admission is not supported by this binding.
type resourceSetupBinding struct {
	Purpose                string `json:"purpose"`
	OperatorAccountID      string `json:"operatorAccountId"`
	ControlPrincipal       string `json:"controlPrincipal"`
	EnvironmentID          string `json:"environmentId"`
	SessionID              string `json:"sessionId"`
	LeaseID                string `json:"leaseId"`
	SandboxID              string `json:"sandboxId"`
	Generation             int64  `json:"generation"`
	PhysicalOwnerID        string `json:"physicalOwnerId"`
	PhysicalAttemptKey     string `json:"physicalAttemptKey"`
	AuthorityDigest        string `json:"authorityDigest"`
	ParentAuthorityDigest  string `json:"parentAuthorityDigest"`
	PhysicalOwnerAuditHash string `json:"physicalOwnerAuditHash"`
	OperationID            string `json:"operationId"`
	ExpiresAt              int64  `json:"expiresAt"`
}

type resourceProvisionRequest struct {
	Version        int                  `json:"version"`
	Binding        resourceSetupBinding `json:"binding"`
	ExpectedBootID string               `json:"expectedBootId"`
	ExpectedParent rootIdentity         `json:"expectedParent"`
	Policy         string               `json:"policy"`
}

type resourceCgroupObservation struct {
	Identity rootIdentity      `json:"identity"`
	Values   map[string]string `json:"values"`
}

type resourceProvisionReceipt struct {
	Version               int                       `json:"version"`
	Operation             string                    `json:"operation"`
	Binding               resourceSetupBinding      `json:"binding"`
	Policy                string                    `json:"policy"`
	SandboxBootID         string                    `json:"sandboxBootId"`
	Parent                resourceCgroupObservation `json:"parent"`
	Boundary              resourceCgroupObservation `json:"boundary"`
	Control               resourceCgroupObservation `json:"control"`
	Commands              resourceCgroupObservation `json:"commands"`
	MemTotal              uint64                    `json:"memTotal,string"`
	MemAvailable          uint64                    `json:"memAvailable,string"`
	SiblingProtectedBytes uint64                    `json:"siblingProtectedBytes,string"`
}

// Fixed trusted setup only: no shell, subprocess, workload, arbitrary paths,
// privilege escalation, controller migration, mount/remount, or adoption of an
// existing hierarchy. A partial failure leaves the original intent owned; this
// helper never fabricates rollback, EOF, runtime qualification or readiness.
func provisionResources() error {
	if requireToolIdentity() != nil {
		return errors.New("protected_owner_required")
	}
	var input resourceProvisionRequest
	if decodeBounded(os.Stdin, maxRequestBytes, &input) != nil || validateResourceSetup(input) != nil {
		return errors.New("resource_setup_binding_required")
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || strings.TrimSpace(string(boot)) != input.ExpectedBootID {
		return errors.New("resource_boot_changed")
	}
	parent, err := openProtectedCgroup("/sys/fs/cgroup")
	if err != nil {
		return err
	}
	defer parent.Close()
	identity, err := heldResourceIdentity(parent)
	if err != nil || identity != input.ExpectedParent || requireVisibleCgroupRoot(parent) != nil {
		return errors.New("complete_resource_ancestry_required")
	}
	parentObservation, err := observeCgroup(parent, []string{"cgroup.type", "cgroup.controllers", "cgroup.subtree_control"})
	if err != nil || parentObservation.Values["cgroup.type"] != "domain" ||
		!hasControllers(parentObservation.Values["cgroup.controllers"]) || !hasControllers(parentObservation.Values["cgroup.subtree_control"]) {
		// The platform owner must already delegate these controllers. Never
		// change the guest/host root or another owner's controller policy here.
		return errors.New("platform_resource_delegation_required")
	}
	total, available, err := provisionMemoryObservation()
	if err != nil || total < resourceBoundaryMemory+controlMemoryReserve || available < resourceBoundaryMemory+controlMemoryReserve {
		return errors.New("resource_headroom_unavailable")
	}
	siblings, protectedBytes, err := pinResourceSiblings(parent)
	if err != nil {
		return err
	}
	defer closeResourceSiblings(siblings)
	if protectedBytes > total-resourceBoundaryMemory-controlMemoryReserve {
		return errors.New("ancestor_memory_protection_overcommitted")
	}
	if input.Binding.ExpiresAt <= time.Now().UnixMilli() {
		return errors.New("resource_grant_expired")
	}
	boundary, err := createResourceDirectory(parent, "legioncode-native")
	if err != nil {
		return err
	}
	defer boundary.Close()
	if configureResourceValues(boundary, [][2]string{
		{"memory.max", strconv.Itoa(resourceBoundaryMemory)}, {"memory.min", strconv.Itoa(controlMemoryReserve)},
		{"memory.swap.max", "0"}, {"memory.oom.group", "0"}, {"pids.max", strconv.Itoa(resourceBoundaryPids)},
		{"cpu.max", "100000 100000"},
	}) != nil || enableOwnedControllers(boundary) != nil {
		return errors.New("resource_boundary_enforcement_unavailable")
	}
	control, err := createResourceDirectory(boundary, "control")
	if err != nil {
		return err
	}
	defer control.Close()
	if configureResourceValues(control, [][2]string{
		{"memory.max", strconv.Itoa(controlMemoryReserve)}, {"memory.min", strconv.Itoa(controlMemoryReserve)},
		{"memory.swap.max", "0"}, {"memory.oom.group", "0"}, {"pids.max", strconv.Itoa(resourceControlPids)},
		{"cpu.max", "100000 100000"}, {"cpu.weight", "10000"},
	}) != nil {
		return errors.New("resource_control_enforcement_unavailable")
	}
	commands, err := createResourceDirectory(boundary, "commands")
	if err != nil {
		return err
	}
	defer commands.Close()
	if configureResourceValues(commands, [][2]string{
		{"memory.max", strconv.Itoa(resourceCommandMemory)}, {"memory.min", "0"},
		{"memory.swap.max", "0"}, {"memory.oom.group", "0"}, {"pids.max", strconv.Itoa(resourceCommandPids)},
		{"cpu.max", "100000 100000"}, {"cpu.weight", "100"},
	}) != nil || enableOwnedControllers(commands) != nil {
		return errors.New("resource_command_enforcement_unavailable")
	}
	limits := resourceLimits{MemoryBytes: resourceCommandMemory, Pids: resourceCommandPids, CPUQuotaMicros: 100000, CPUPeriodMicros: 100000}
	if verifyResourceBudgets(boundary, control, commands, limits) != nil || verifyResourceSiblings(parent, siblings, boundary) != nil {
		return errors.New("resource_ancestry_changed")
	}
	// No process is migrated or launched by setup. The original supervisor is
	// moved into this exact control sibling later, before atomic child birth.
	for _, directory := range []*os.File{boundary, control, commands} {
		processes, readErr := readCgroupFile(directory, "cgroup.procs")
		if readErr != nil || processes != "" {
			return errors.New("resource_creator_freeze_unconfirmed")
		}
	}
	knobs := []string{"cgroup.type", "cgroup.subtree_control", "memory.max", "memory.min", "memory.swap.max", "memory.oom.group", "pids.max", "cpu.max", "cpu.weight"}
	boundaryObservation, err := observeCgroup(boundary, knobs)
	if err != nil {
		return err
	}
	controlObservation, err := observeCgroup(control, knobs)
	if err != nil {
		return err
	}
	commandObservation, err := observeCgroup(commands, knobs)
	if err != nil {
		return err
	}
	finalTotal, finalAvailable, err := provisionMemoryObservation()
	finalBoot, bootErr := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || bootErr != nil || strings.TrimSpace(string(finalBoot)) != input.ExpectedBootID || finalTotal != total ||
		finalAvailable < resourceBoundaryMemory+controlMemoryReserve || verifyResourceSiblings(parent, siblings, boundary) != nil ||
		verifyResourceRoot(parent, input.ExpectedParent) != nil || verifyResourceObservation(parent, parentObservation) != nil ||
		verifyResourceObservation(boundary, boundaryObservation) != nil || verifyResourceObservation(control, controlObservation) != nil ||
		verifyResourceObservation(commands, commandObservation) != nil {
		return errors.New("resource_headroom_changed")
	}
	return json.NewEncoder(os.Stdout).Encode(resourceProvisionReceipt{
		Version: 1, Operation: "resource_provision", Binding: input.Binding, Policy: resourcePolicy,
		SandboxBootID: input.ExpectedBootID, Parent: parentObservation, Boundary: boundaryObservation,
		Control: controlObservation, Commands: commandObservation, MemTotal: total, MemAvailable: finalAvailable,
		SiblingProtectedBytes: protectedBytes,
	})
}

func validateResourceSetup(input resourceProvisionRequest) error {
	if input.Version != 1 || input.Policy != resourcePolicy || input.ExpectedParent.Inode == 0 || len(input.ExpectedBootID) != 36 {
		return errors.New("invalid_resource_setup")
	}
	return validateResourceSetupBinding(input.Binding)
}
func validateResourceSetupBinding(value resourceSetupBinding) error {
	if value.Purpose != "native_boundary_qualification" || value.Generation != 0 || value.ExpiresAt <= time.Now().UnixMilli() || len(value.OperatorAccountID) != 32 ||
		!hexadecimal.MatchString(value.AuthorityDigest) || !hexadecimal.MatchString(value.ParentAuthorityDigest) ||
		!hexadecimal.MatchString(value.PhysicalOwnerAuditHash) || !opaqueID.MatchString(value.OperationID) {
		return errors.New("invalid_resource_setup")
	}
	for _, id := range []string{value.OperatorAccountID, value.ControlPrincipal, value.EnvironmentID,
		value.SessionID, value.LeaseID, value.SandboxID, value.PhysicalOwnerID, value.PhysicalAttemptKey} {
		if !opaqueID.MatchString(id) {
			return errors.New("invalid_resource_setup")
		}
	}
	return nil
}

// Read-only metadata for an already persisted exclusive operator grant. It is
// never an implicit probe, an arbitrary path operation or runtime readiness.
func observeResourceRoot() error {
	if requireToolIdentity() != nil {
		return errors.New("protected_owner_required")
	}
	var input struct {
		Version int                  `json:"version"`
		Binding resourceSetupBinding `json:"binding"`
		Policy  string               `json:"policy"`
	}
	if decodeBounded(os.Stdin, maxRequestBytes, &input) != nil || input.Version != 1 || input.Policy != resourcePolicy ||
		validateResourceSetupBinding(input.Binding) != nil {
		return errors.New("invalid_resource_setup")
	}
	parent, err := openProtectedCgroup("/sys/fs/cgroup")
	if err != nil {
		return err
	}
	defer parent.Close()
	if requireVisibleCgroupRoot(parent) != nil {
		return errors.New("complete_resource_ancestry_required")
	}
	observation, err := observeCgroup(parent, []string{"cgroup.type", "cgroup.controllers", "cgroup.subtree_control"})
	if err != nil {
		return err
	}
	total, available, err := provisionMemoryObservation()
	if err != nil {
		return err
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || len(strings.TrimSpace(string(boot))) != 36 {
		return errors.New("resource_boot_unavailable")
	}
	helperHash, err := resourceHelperHash()
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		Version       int                       `json:"version"`
		Operation     string                    `json:"operation"`
		Binding       resourceSetupBinding      `json:"binding"`
		Policy        string                    `json:"policy"`
		SandboxBootID string                    `json:"sandboxBootId"`
		Parent        resourceCgroupObservation `json:"parent"`
		MemTotal      uint64                    `json:"memTotal,string"`
		MemAvailable  uint64                    `json:"memAvailable,string"`
		HelperSha256  string                    `json:"helperSha256"`
	}{1, "resource_observation", input.Binding, resourcePolicy, strings.TrimSpace(string(boot)), observation, total, available, helperHash})
}

// A namespace-relative mount can hide tighter ancestors and effective min
// clipping. Require the actual kernel hierarchy root, not a cgroup-namespace
// root whose memory.* controls still expose its hidden parent-owned limits.
// The selected profile has no nested/delegated-root fallback.
func requireVisibleCgroupRoot(root *os.File) error {
	for _, name := range []string{"memory.max", "memory.min", "memory.current", "pids.max"} {
		fd, err := syscall.Openat(int(root.Fd()), name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if err == nil {
			_ = syscall.Close(fd)
			return errors.New("hidden_resource_ancestors_unavailable")
		}
		if err != syscall.ENOENT {
			return errors.New("resource_ancestry_unavailable")
		}
	}
	return nil
}

func heldResourceIdentity(directory *os.File) (rootIdentity, error) {
	var info syscall.Stat_t
	if syscall.Fstat(int(directory.Fd()), &info) != nil || info.Uid != 0 || info.Mode&0022 != 0 || info.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return rootIdentity{}, errors.New("protected_resource_identity_required")
	}
	return rootIdentity{Device: uint64(info.Dev), Inode: info.Ino}, nil
}

func createResourceDirectory(parent *os.File, name string) (*os.File, error) {
	if syscall.Mkdirat(int(parent.Fd()), name, 0700) != nil {
		// Existing or partial generations are never silently adopted.
		return nil, errors.New("resource_setup_intent_collision")
	}
	fd, err := syscall.Openat(int(parent.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("resource_setup_directory_unavailable")
	}
	file := os.NewFile(uintptr(fd), "held-resource-directory")
	if _, err := heldResourceIdentity(file); err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}

func configureResourceValues(directory *os.File, values [][2]string) error {
	for _, pair := range values {
		if writeCgroupFile(directory, pair[0], pair[1]) != nil {
			return errors.New("resource_setting_unavailable")
		}
		observed, err := readCgroupFile(directory, pair[0])
		if err != nil || observed != pair[1] {
			return errors.New("resource_setting_unconfirmed")
		}
	}
	return nil
}

func enableOwnedControllers(directory *os.File) error {
	available, err := readCgroupFile(directory, "cgroup.controllers")
	processes, processErr := readCgroupFile(directory, "cgroup.procs")
	if err != nil || processErr != nil || !hasControllers(available) || processes != "" ||
		writeCgroupFile(directory, "cgroup.subtree_control", "+cpu +memory +pids") != nil {
		return errors.New("resource_controller_delegation_unavailable")
	}
	observed, err := readCgroupFile(directory, "cgroup.subtree_control")
	if err != nil || !hasControllers(observed) {
		return errors.New("resource_controller_delegation_unconfirmed")
	}
	return nil
}

func observeCgroup(directory *os.File, knobs []string) (resourceCgroupObservation, error) {
	identity, err := heldResourceIdentity(directory)
	if err != nil {
		return resourceCgroupObservation{}, err
	}
	values := make(map[string]string, len(knobs))
	for _, name := range knobs {
		value, err := readCgroupFile(directory, name)
		if err != nil {
			return resourceCgroupObservation{}, err
		}
		values[name] = value
	}
	return resourceCgroupObservation{Identity: identity, Values: values}, nil
}

func verifyResourceObservation(directory *os.File, expected resourceCgroupObservation) error {
	identity, err := heldResourceIdentity(directory)
	if err != nil || identity != expected.Identity {
		return errors.New("resource_observation_changed")
	}
	for name, value := range expected.Values {
		actual, err := readCgroupFile(directory, name)
		if err != nil || actual != value {
			return errors.New("resource_observation_changed")
		}
	}
	return nil
}

func verifyResourceRoot(held *os.File, expected rootIdentity) error {
	current, err := openProtectedCgroup("/sys/fs/cgroup")
	if err != nil {
		return err
	}
	defer current.Close()
	actual, err := heldResourceIdentity(current)
	original, heldErr := heldResourceIdentity(held)
	if err != nil || heldErr != nil || actual != expected || original != expected || requireVisibleCgroupRoot(current) != nil {
		return errors.New("resource_ancestor_identity_changed")
	}
	return nil
}

func provisionMemoryObservation() (uint64, uint64, error) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil || len(data) > 64*1024 {
		return 0, 0, errors.New("resource_memory_observation_unavailable")
	}
	values := make(map[string]uint64)
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 3 && (fields[0] == "MemTotal:" || fields[0] == "MemAvailable:") && fields[2] == "kB" {
			value, parseErr := strconv.ParseUint(fields[1], 10, 53)
			if parseErr != nil || value > ^uint64(0)/1024 {
				return 0, 0, errors.New("resource_memory_observation_unavailable")
			}
			values[fields[0]] = value * 1024
		}
	}
	if values["MemTotal:"] == 0 || values["MemAvailable:"] == 0 || values["MemAvailable:"] > values["MemTotal:"] {
		return 0, 0, errors.New("resource_memory_observation_unavailable")
	}
	return values["MemTotal:"], values["MemAvailable:"], nil
}

type resourceSibling struct {
	name     string
	file     *os.File
	identity rootIdentity
	minimum  string
}

func resourceDirectoryNames(parent *os.File) ([]string, error) {
	fd, err := syscall.Openat(int(parent.Fd()), ".", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	reader := os.NewFile(uintptr(fd), "resource-directory-list")
	defer reader.Close()
	entries, err := reader.Readdirnames(1025)
	if (err != nil && err != io.EOF) || len(entries) > 1024 {
		return nil, errors.New("resource_ancestry_limit")
	}
	names := make([]string, 0)
	for _, name := range entries {
		// Readdir with synthetic os.NewFile names can stat relative paths.
		// Enumerate names only; every classification uses the held descriptor.
		fd, openErr := syscall.Openat(int(parent.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if openErr == syscall.ENOTDIR {
			// Interface files are expected, but disappearing/unexpected/symlink
			// entries must not be mistaken for an ignorable controller file.
			leaf, leafErr := syscall.Openat(int(parent.Fd()), name, 0x200000 /* O_PATH */ |syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
			if leafErr != nil {
				return nil, errors.New("resource_entry_changed")
			}
			var info syscall.Stat_t
			statErr := syscall.Fstat(leaf, &info)
			_ = syscall.Close(leaf)
			if statErr != nil || info.Mode&syscall.S_IFMT != syscall.S_IFREG || info.Uid != 0 || info.Mode&0022 != 0 {
				return nil, errors.New("resource_entry_changed")
			}
			continue
		}
		if openErr != nil {
			return nil, errors.New("resource_entry_changed")
		}
		file := os.NewFile(uintptr(fd), "held-resource-entry")
		_, identityErr := heldResourceIdentity(file)
		_ = file.Close()
		if identityErr != nil {
			return nil, identityErr
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

func pinResourceSiblings(parent *os.File) ([]resourceSibling, uint64, error) {
	names, err := resourceDirectoryNames(parent)
	if err != nil {
		return nil, 0, err
	}
	siblings := make([]resourceSibling, 0, len(names))
	var protected uint64
	for _, name := range names {
		if name == "legioncode-native" {
			closeResourceSiblings(siblings)
			return nil, 0, errors.New("resource_setup_intent_collision")
		}
		fd, openErr := syscall.Openat(int(parent.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if openErr != nil {
			closeResourceSiblings(siblings)
			return nil, 0, errors.New("resource_sibling_unavailable")
		}
		file := os.NewFile(uintptr(fd), "held-resource-sibling")
		identity, identityErr := heldResourceIdentity(file)
		minimum, readErr := readCgroupFile(file, "memory.min")
		bytes, parseErr := strconv.ParseUint(minimum, 10, 53)
		if identityErr != nil || readErr != nil || parseErr != nil || protected > ^uint64(0)-bytes {
			_ = file.Close()
			closeResourceSiblings(siblings)
			return nil, 0, errors.New("effective_resource_protection_unavailable")
		}
		protected += bytes
		siblings = append(siblings, resourceSibling{name: name, file: file, identity: identity, minimum: minimum})
	}
	return siblings, protected, nil
}

func verifyResourceSiblings(parent *os.File, siblings []resourceSibling, boundary *os.File) error {
	names, err := resourceDirectoryNames(parent)
	if err != nil || len(names) != len(siblings)+1 {
		return errors.New("resource_sibling_graph_changed")
	}
	boundIdentity, err := heldResourceIdentity(boundary)
	if err != nil {
		return err
	}
	for _, name := range names {
		expected := boundIdentity
		var sibling *resourceSibling
		if name != "legioncode-native" {
			for i := range siblings {
				if siblings[i].name == name {
					sibling = &siblings[i]
					expected = sibling.identity
					break
				}
			}
			if sibling == nil {
				return errors.New("resource_sibling_graph_changed")
			}
		}
		fd, openErr := syscall.Openat(int(parent.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if openErr != nil {
			return errors.New("resource_sibling_graph_changed")
		}
		file := os.NewFile(uintptr(fd), "current-resource-sibling")
		observed, identityErr := heldResourceIdentity(file)
		_ = file.Close()
		if identityErr != nil || observed != expected {
			return errors.New("resource_sibling_graph_changed")
		}
		if sibling != nil {
			minimum, readErr := readCgroupFile(sibling.file, "memory.min")
			if readErr != nil || minimum != sibling.minimum {
				return errors.New("effective_resource_protection_changed")
			}
		}
	}
	return nil
}

func closeResourceSiblings(siblings []resourceSibling) {
	for _, sibling := range siblings {
		_ = sibling.file.Close()
	}
}

func resourceHelperHash() (string, error) {
	file, err := os.Open("/proc/self/exe")
	if err != nil {
		return "", errors.New("installed_helper_identity_unavailable")
	}
	defer file.Close()
	var before, after syscall.Stat_t
	if syscall.Fstat(int(file.Fd()), &before) != nil || before.Uid != 0 || before.Mode&0022 != 0 ||
		before.Mode&syscall.S_IFMT != syscall.S_IFREG || before.Size <= 0 || before.Size > 32*1024*1024 {
		return "", errors.New("installed_helper_identity_unavailable")
	}
	digest := sha256.New()
	count, err := io.Copy(digest, io.LimitReader(file, 32*1024*1024+1))
	if err != nil || count != before.Size || syscall.Fstat(int(file.Fd()), &after) != nil || before.Dev != after.Dev ||
		before.Ino != after.Ino || before.Mode != after.Mode || before.Uid != after.Uid || before.Gid != after.Gid ||
		before.Size != after.Size || before.Mtim != after.Mtim || before.Ctim != after.Ctim {
		return "", errors.New("installed_helper_identity_changed")
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
