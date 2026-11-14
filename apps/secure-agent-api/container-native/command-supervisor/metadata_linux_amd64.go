//go:build linux && amd64

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type metadataEntry struct {
	Path   string `json:"path"`
	Device uint64 `json:"device"`
	Inode  uint64 `json:"inode"`
	Kind   string `json:"kind"`
}
type metadataProtection struct {
	Identity string          `json:"identity"`
	Entries  []metadataEntry `json:"entries"`
}
type initMetadataEntry struct {
	metadataEntry
	Descriptor int `json:"descriptor"`
}

// Git discovery is deliberately absent. The canonical owner supplies exact
// metadata identities; this adapter pins and enforces those existing authorities.
func pinMetadata(value metadataProtection) ([]*os.File, error) {
	if value.Identity == "" || len(value.Identity) > 512 || len(value.Entries) < 1 || len(value.Entries) > 32 {
		return nil, errors.New("canonical_metadata_required")
	}
	files := []*os.File{}
	failed := true
	defer func() {
		if failed {
			for _, file := range files {
				_ = file.Close()
			}
		}
	}()
	for _, entry := range value.Entries {
		if !strings.HasPrefix(entry.Path, "/home/sandbox/") || filepath.Clean(entry.Path) != entry.Path || entry.Inode == 0 || (entry.Kind != "directory" && entry.Kind != "file") {
			return nil, errors.New("canonical_metadata_required")
		}
		fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
		if err != nil {
			return nil, errors.New("metadata_unavailable")
		}
		parts := strings.Split(strings.TrimPrefix(entry.Path, "/"), "/")
		for index, part := range parts {
			flags := syscall.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC | syscall.O_NONBLOCK
			if index != len(parts)-1 || entry.Kind == "directory" {
				flags |= syscall.O_DIRECTORY
			}
			next, openErr := syscall.Openat(fd, part, flags, 0)
			_ = syscall.Close(fd)
			if openErr != nil {
				return nil, errors.New("metadata_unavailable")
			}
			fd = next
		}
		file := os.NewFile(uintptr(fd), "protected-metadata")
		files = append(files, file)
		var info syscall.Stat_t
		if syscall.Fstat(fd, &info) != nil || uint64(info.Dev) != entry.Device || info.Ino != entry.Inode ||
			(entry.Kind == "directory" && info.Mode&syscall.S_IFMT != syscall.S_IFDIR) ||
			(entry.Kind == "file" && info.Mode&syscall.S_IFMT != syscall.S_IFREG) {
			return nil, errors.New("metadata_identity_changed")
		}
		remaining := 100_000
		if verifyProtectedMetadata(file, entry.Device, 0, &remaining) != nil {
			return nil, errors.New("metadata_alias_protection_unavailable")
		}
	}
	failed = false
	return files, nil
}

func verifyProtectedMetadata(file *os.File, device uint64, depth int, remaining *int) error {
	*remaining--
	var info syscall.Stat_t
	if *remaining < 0 || depth > 128 || syscall.Fstat(int(file.Fd()), &info) != nil || uint64(info.Dev) != device || info.Uid != 0 || info.Mode&0022 != 0 {
		return errors.New("metadata_not_protected")
	}
	kind := info.Mode & syscall.S_IFMT
	if kind == syscall.S_IFREG {
		if info.Nlink != 1 {
			return errors.New("metadata_hardlink_not_protected")
		}
		return nil
	}
	if kind != syscall.S_IFDIR {
		return errors.New("metadata_alias_not_protected")
	}
	for {
		names, err := file.Readdirnames(128)
		for _, name := range names {
			fd, openErr := syscall.Openat(int(file.Fd()), name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
			if openErr != nil {
				return errors.New("metadata_entry_unavailable")
			}
			child := os.NewFile(uintptr(fd), "metadata-entry")
			verifyErr := verifyProtectedMetadata(child, device, depth+1, remaining)
			_ = child.Close()
			if verifyErr != nil {
				return verifyErr
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	_, err := file.Seek(0, 0)
	return err
}

func metadataAt(value metadataProtection, path string, info syscall.Stat_t) (bool, error) {
	for _, entry := range value.Entries {
		if uint64(info.Dev) == entry.Device && info.Ino == entry.Inode {
			if entry.Path != path {
				return false, errors.New("uncovered_metadata_alias")
			}
			return true, nil
		}
		if path == entry.Path {
			return false, errors.New("metadata_identity_changed")
		}
	}
	return false, nil
}

func mountProtectedMetadata(input initRequest) error {
	for _, entry := range input.Metadata {
		if entry.Descriptor < 7 || entry.Descriptor > 38 || filepath.Clean(entry.Path) != entry.Path || !strings.HasPrefix(entry.Path, "/home/sandbox/") {
			return errors.New("metadata_mount_unavailable")
		}
		var info syscall.Stat_t
		if syscall.Fstat(entry.Descriptor, &info) != nil || uint64(info.Dev) != entry.Device || info.Ino != entry.Inode {
			return errors.New("metadata_identity_changed")
		}
		target := filepath.Join(input.RootFS, strings.TrimPrefix(entry.Path, "/"))
		if entry.Kind == "directory" {
			if os.MkdirAll(target, 0755) != nil {
				return errors.New("metadata_mount_unavailable")
			}
		} else {
			if os.MkdirAll(filepath.Dir(target), 0755) != nil {
				return errors.New("metadata_mount_unavailable")
			}
			file, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|syscall.O_NOFOLLOW, 0644)
			if err != nil {
				return errors.New("metadata_mount_unavailable")
			}
			_ = file.Close()
		}
		if syscall.Mount(fmt.Sprintf("/proc/self/fd/%d", entry.Descriptor), target, "", syscall.MS_BIND, "") != nil ||
			syscall.Mount("", target, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY|syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, "") != nil {
			return errors.New("metadata_mount_unavailable")
		}
		_ = syscall.Close(entry.Descriptor)
	}
	return nil
}
