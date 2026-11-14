//go:build linux && amd64

package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
)

type workspaceRequest struct {
	Binding       binding       `json:"binding"`
	Root          string        `json:"root"`
	MetadataPaths metadataPaths `json:"metadataPaths"`
}

// Invoked only by the physical checkout owner before the initial baseline.
// This trusted filesystem operation never evaluates repository code or follows
// a link. The caller persists intent and retains its existing writer throughout.
func prepareWorkspace() error {
	if requireToolIdentity() != nil {
		return errors.New("protected_owner_required")
	}
	var input workspaceRequest
	if decodeBounded(os.Stdin, maxRequestBytes, &input) != nil ||
		!hexadecimal.MatchString(input.Binding.Nonce) || input.Binding.Generation < 0 ||
		!strings.HasPrefix(input.Root, "/home/sandbox/checkouts/") ||
		filepath.Clean(input.Root) != input.Root || strings.Count(input.Root, "/") != 4 {
		return errors.New("invalid_workspace")
	}
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return errors.New("workspace_unavailable")
	}
	for _, component := range strings.Split(strings.TrimPrefix(input.Root, "/"), "/") {
		next, openErr := syscall.Openat(fd, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		_ = syscall.Close(fd)
		if openErr != nil {
			return errors.New("workspace_unavailable")
		}
		fd = next
	}
	root := os.NewFile(uintptr(fd), "held-workspace")
	defer root.Close()
	if input.MetadataPaths.WorkspaceRoot != input.Root {
		return errors.New("metadata_scope_changed")
	}
	protection, err := resolveMetadataPaths(input.MetadataPaths, root)
	if err != nil {
		return err
	}
	metadata, err := pinMetadata(protection, root)
	if err != nil {
		return err
	}
	defer func() {
		for _, file := range metadata {
			_ = file.Close()
		}
	}()
	var identity syscall.Stat_t
	if syscall.Fstat(fd, &identity) != nil {
		return errors.New("workspace_identity_unavailable")
	}
	remaining := 100_000
	if prepareWorkspaceEntry(root, input.Root, protection, uint64(identity.Dev), 0, &remaining) != nil {
		return errors.New("workspace_ownership_unavailable")
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || len(strings.TrimSpace(string(boot))) != 36 {
		return errors.New("sandbox_identity_unavailable")
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		Binding       binding            `json:"binding"`
		Root          rootIdentity       `json:"root"`
		SandboxBootID string             `json:"sandboxBootId"`
		Metadata      metadataProtection `json:"metadata"`
	}{Binding: input.Binding, Root: rootIdentity{Device: uint64(identity.Dev), Inode: identity.Ino}, SandboxBootID: strings.TrimSpace(string(boot)), Metadata: protection})
}

func prepareWorkspaceEntry(file *os.File, path string, metadata metadataProtection, device uint64, depth int, remaining *int) error {
	*remaining--
	if *remaining < 0 || depth > 128 {
		return errors.New("workspace_limit")
	}
	var info syscall.Stat_t
	if syscall.Fstat(int(file.Fd()), &info) != nil || uint64(info.Dev) != device ||
		(info.Uid != 0 && info.Uid != toolHostUID) || (info.Gid != 0 && info.Gid != toolHostGID) {
		return errors.New("workspace_identity_changed")
	}
	protected, err := metadataAt(metadata, path, info)
	if err != nil {
		return err
	}
	if protected {
		return nil
	}
	kind := info.Mode & syscall.S_IFMT
	if kind == syscall.S_IFLNK {
		// O_PATH|O_NOFOLLOW opened the link itself. Its target is never opened
		// or chowned and is constrained by the later detached root namespace.
		return nil
	}
	if (kind != syscall.S_IFREG && kind != syscall.S_IFDIR) || (kind == syscall.S_IFREG && info.Nlink != 1) {
		return errors.New("workspace_entry_not_owned")
	}
	if kind == syscall.S_IFDIR {
		for {
			names, err := file.Readdirnames(128)
			for _, name := range names {
				if name == "." || name == ".." || strings.Contains(name, "/") {
					return errors.New("workspace_entry_invalid")
				}
				// First pin without opening devices/FIFOs or following links.
				pin, openErr := syscall.Openat(int(file.Fd()), name, 0x200000 /* O_PATH */ |syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
				if openErr != nil {
					return openErr
				}
				var childInfo syscall.Stat_t
				if syscall.Fstat(pin, &childInfo) != nil {
					_ = syscall.Close(pin)
					return errors.New("workspace_entry_unavailable")
				}
				var child *os.File
				if childInfo.Mode&syscall.S_IFMT == syscall.S_IFLNK {
					child = os.NewFile(uintptr(pin), "workspace-link")
				} else {
					if childInfo.Mode&syscall.S_IFMT != syscall.S_IFREG && childInfo.Mode&syscall.S_IFMT != syscall.S_IFDIR {
						_ = syscall.Close(pin)
						return errors.New("workspace_entry_invalid")
					}
					opened, openErr := syscall.Openat(int(file.Fd()), name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
					_ = syscall.Close(pin)
					if openErr != nil {
						return openErr
					}
					var actual syscall.Stat_t
					if syscall.Fstat(opened, &actual) != nil || actual.Dev != childInfo.Dev || actual.Ino != childInfo.Ino {
						_ = syscall.Close(opened)
						return errors.New("workspace_entry_changed")
					}
					child = os.NewFile(uintptr(opened), "workspace-entry")
				}
				childErr := prepareWorkspaceEntry(child, filepath.Join(path, name), metadata, device, depth+1, remaining)
				_ = child.Close()
				if childErr != nil {
					return childErr
				}
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
		}
	}
	return syscall.Fchown(int(file.Fd()), toolHostUID, toolHostGID)
}

func requireToolIdentity() error {
	if os.Geteuid() != 0 || os.Getegid() != 0 {
		return errors.New("protected_owner_required")
	}
	account, accountErr := user.LookupId("65533")
	group, groupErr := user.LookupGroupId("65533")
	if accountErr != nil || groupErr != nil || account.Username != "legion-native" || account.Gid != "65533" || group.Name != "legion-native" {
		return errors.New("provisioned_tool_identity_required")
	}
	return nil
}
