//go:build linux && amd64

package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type workspaceWriteRequest struct {
	Binding        binding            `json:"binding"`
	Root           string             `json:"root"`
	ExpectedRoot   rootIdentity       `json:"expectedRoot"`
	ExpectedBootID string             `json:"expectedBootId"`
	Metadata       metadataProtection `json:"metadata"`
	Path           string             `json:"path"`
	Content        string             `json:"content"`
	Exclusive      bool               `json:"exclusive"`
}

func writeWorkspaceFile() error {
	if requireToolIdentity() != nil {
		return errors.New("protected_owner_required")
	}
	var input workspaceWriteRequest
	if decodeBounded(os.Stdin, 2*1024*1024, &input) != nil || len(input.Content) > 200_000 ||
		!hexadecimal.MatchString(input.Binding.Nonce) || input.Path == "." || input.Path == "" ||
		filepath.IsAbs(input.Path) || filepath.Clean(input.Path) != input.Path || input.Path == ".." || strings.HasPrefix(input.Path, "../") ||
		input.Metadata.Paths.WorkspaceRoot != input.Root {
		return errors.New("invalid_workspace_write")
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || strings.TrimSpace(string(boot)) != input.ExpectedBootID {
		return errors.New("sandbox_generation_changed")
	}
	root, err := openHeldWorkspace(input.Root, input.ExpectedRoot)
	if err != nil {
		return err
	}
	defer root.Close()
	metadata, err := pinMetadata(input.Metadata, root)
	if err != nil {
		return err
	}
	defer func() {
		for _, file := range metadata {
			_ = file.Close()
		}
	}()
	parentFD, err := syscall.Dup(int(root.Fd()))
	if err != nil {
		return err
	}
	syscall.CloseOnExec(parentFD)
	defer func() { _ = syscall.Close(parentFD) }()
	parts := strings.Split(input.Path, "/")
	if len(parts) > 128 {
		return errors.New("workspace_path_limit")
	}
	parentPath := input.Root
	for _, part := range parts[:len(parts)-1] {
		next, openErr := syscall.Openat(parentFD, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if openErr == syscall.ENOENT {
			if syscall.Mkdirat(parentFD, part, 0755) != nil {
				return errors.New("workspace_parent_unavailable")
			}
			next, openErr = syscall.Openat(parentFD, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
			if openErr == nil && syscall.Fchown(next, toolHostUID, toolHostGID) != nil {
				_ = syscall.Close(next)
				return errors.New("workspace_parent_unavailable")
			}
		}
		if openErr != nil {
			return errors.New("workspace_parent_unavailable")
		}
		parentPath = filepath.Join(parentPath, part)
		if writableWorkspaceEntry(next, parentPath, input, true) != nil {
			_ = syscall.Close(next)
			return errors.New("workspace_parent_protected")
		}
		_ = syscall.Close(parentFD)
		parentFD = next
	}
	name := parts[len(parts)-1]
	mode := uint32(0644)
	previous, openErr := syscall.Openat(parentFD, name, 0x200000 /* O_PATH */ |syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if openErr == nil {
		defer syscall.Close(previous)
		if input.Exclusive || writableWorkspaceEntry(previous, filepath.Join(parentPath, name), input, false) != nil {
			return errors.New("workspace_target_protected")
		}
		var info syscall.Stat_t
		if syscall.Fstat(previous, &info) != nil {
			return errors.New("workspace_target_unavailable")
		}
		mode = info.Mode & 0777
	} else if openErr != syscall.ENOENT {
		return errors.New("workspace_target_unavailable")
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return errors.New("workspace_write_unavailable")
	}
	temporary := ".legioncode-native-write-" + hex.EncodeToString(nonce[:])
	fd, err := syscall.Openat(parentFD, temporary, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return errors.New("workspace_write_unavailable")
	}
	file := os.NewFile(uintptr(fd), "workspace-write")
	defer file.Close()
	defer syscall.Unlinkat(parentFD, temporary)
	if count, err := file.WriteString(input.Content); err != nil || count != len(input.Content) {
		return errors.New("workspace_write_unsettled")
	}
	if file.Sync() != nil || syscall.Fchown(fd, toolHostUID, toolHostGID) != nil || syscall.Fchmod(fd, mode) != nil {
		return errors.New("workspace_write_unsettled")
	}
	// Recheck the old entry immediately before publishing the replacement. The
	// existing physical writer excludes other command creators during this operation.
	current, err := syscall.Openat(parentFD, name, 0x200000|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if previous >= 0 && openErr == nil {
		if err != nil {
			return errors.New("workspace_target_changed")
		}
		var before, after syscall.Stat_t
		bad := syscall.Fstat(previous, &before) != nil || syscall.Fstat(current, &after) != nil || before.Dev != after.Dev || before.Ino != after.Ino
		_ = syscall.Close(current)
		if bad {
			return errors.New("workspace_target_changed")
		}
	} else if err != syscall.ENOENT {
		if err == nil {
			_ = syscall.Close(current)
		}
		return errors.New("workspace_target_changed")
	}
	if syscall.Renameat(parentFD, temporary, parentFD, name) != nil || syscall.Fsync(parentFD) != nil {
		return errors.New("workspace_publication_unsettled")
	}
	var written syscall.Stat_t
	if syscall.Fstat(fd, &written) != nil {
		return errors.New("workspace_write_identity_unavailable")
	}
	sum := sha256.Sum256([]byte(input.Content))
	return json.NewEncoder(os.Stdout).Encode(struct {
		Binding          binding      `json:"binding"`
		Root             rootIdentity `json:"root"`
		SandboxBootID    string       `json:"sandboxBootId"`
		MetadataIdentity string       `json:"metadataIdentity"`
		Path             string       `json:"path"`
		File             rootIdentity `json:"file"`
		Bytes            int          `json:"bytes"`
		SHA256           string       `json:"sha256"`
	}{input.Binding, input.ExpectedRoot, input.ExpectedBootID, input.Metadata.Identity, input.Path, rootIdentity{uint64(written.Dev), written.Ino}, len(input.Content), hex.EncodeToString(sum[:])})
}

func writableWorkspaceEntry(fd int, path string, input workspaceWriteRequest, directory bool) error {
	var info syscall.Stat_t
	if syscall.Fstat(fd, &info) != nil || uint64(info.Dev) != input.ExpectedRoot.Device ||
		(info.Uid != 0 && info.Uid != toolHostUID) {
		return errors.New("workspace_entry_changed")
	}
	protected, err := metadataAt(input.Metadata, path, info)
	if err != nil || protected {
		return errors.New("workspace_metadata_protected")
	}
	if directory && info.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return errors.New("workspace_parent_invalid")
	}
	if !directory && (info.Mode&syscall.S_IFMT != syscall.S_IFREG || info.Nlink != 1) {
		return errors.New("workspace_file_invalid")
	}
	return nil
}
