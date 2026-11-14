//go:build linux && amd64

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// Git's canonical service resolves these paths. This backend checks exact
// known representations and physical associations, never interprets a generic
// gitfile path or manufactures authority from the Git CLI's pathname strings.
type metadataPaths struct {
	Version            int     `json:"version"`
	WorkspaceRoot      string  `json:"workspaceRoot"`
	GitEntry           string  `json:"gitEntry"`
	GitDirectory       string  `json:"gitDirectory"`
	CommonDirectory    string  `json:"commonDirectory"`
	BacklinkPath       *string `json:"backlinkPath"`
	BacklinkRecordPath *string `json:"backlinkRecordPath"`
}

func resolveMetadataPaths(paths metadataPaths, root *os.File) (metadataProtection, error) {
	if paths.Version != 1 || paths.GitEntry != paths.WorkspaceRoot+"/.git" {
		return metadataProtection{}, errors.New("canonical_metadata_paths_required")
	}
	names := []string{paths.GitEntry, paths.GitDirectory, paths.CommonDirectory}
	if paths.BacklinkPath != nil {
		names = append(names, *paths.BacklinkPath)
	}
	if paths.BacklinkRecordPath != nil {
		names = append(names, *paths.BacklinkRecordPath)
	}
	protection := metadataProtection{Paths: paths}
	seen := map[string]bool{}
	for _, name := range names {
		if seen[name] {
			continue
		}
		seen[name] = true
		file, err := openMetadataPath(name)
		if err != nil {
			return metadataProtection{}, err
		}
		var info syscall.Stat_t
		err = syscall.Fstat(int(file.Fd()), &info)
		_ = file.Close()
		if err != nil {
			return metadataProtection{}, errors.New("metadata_identity_unavailable")
		}
		kind := "file"
		if info.Mode&syscall.S_IFMT == syscall.S_IFDIR {
			kind = "directory"
		}
		protection.Entries = append(protection.Entries, metadataEntry{Path: name, Device: uint64(info.Dev), Inode: info.Ino, Kind: kind})
	}
	identity, err := metadataFingerprint(protection, root)
	if err != nil {
		return metadataProtection{}, err
	}
	protection.Identity = identity
	return protection, nil
}

func openMetadataPath(path string) (*os.File, error) {
	if !strings.HasPrefix(path, "/home/sandbox/") || filepath.Clean(path) != path {
		return nil, errors.New("canonical_metadata_paths_required")
	}
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for index, part := range parts {
		flags := 0x200000 /* O_PATH */ | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
		if index != len(parts)-1 {
			flags |= syscall.O_DIRECTORY
		}
		next, openErr := syscall.Openat(fd, part, flags, 0)
		_ = syscall.Close(fd)
		if openErr != nil {
			return nil, errors.New("metadata_path_unavailable")
		}
		fd = next
		var info syscall.Stat_t
		if syscall.Fstat(fd, &info) != nil ||
			(index == len(parts)-1 && info.Uid != 0) || (index != len(parts)-1 && info.Uid != 0 && info.Uid != toolHostUID) || info.Mode&0022 != 0 ||
			(info.Mode&syscall.S_IFMT != syscall.S_IFDIR && info.Mode&syscall.S_IFMT != syscall.S_IFREG) {
			_ = syscall.Close(fd)
			return nil, errors.New("metadata_path_not_protected")
		}
	}
	defer syscall.Close(fd)
	// Reopen only the pinned regular file/directory, never a device/FIFO/link.
	opened, err := syscall.Open(fmt.Sprintf("/proc/self/fd/%d", fd), syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, errors.New("metadata_handle_unavailable")
	}
	return os.NewFile(uintptr(opened), "metadata-pin"), nil
}

func verifyMetadataGraph(value metadataProtection, files []*os.File, root *os.File) error {
	paths := value.Paths
	if paths.Version != 1 || paths.GitEntry != paths.WorkspaceRoot+"/.git" {
		return errors.New("canonical_metadata_paths_required")
	}
	held := map[string]*os.File{}
	for index, entry := range value.Entries {
		held[entry.Path] = files[index]
	}
	entry, directory, common := held[paths.GitEntry], held[paths.GitDirectory], held[paths.CommonDirectory]
	if entry == nil || directory == nil || common == nil {
		return errors.New("metadata_graph_incomplete")
	}
	var entryInfo, dirInfo, commonInfo syscall.Stat_t
	if syscall.Fstat(int(entry.Fd()), &entryInfo) != nil || syscall.Fstat(int(directory.Fd()), &dirInfo) != nil || syscall.Fstat(int(common.Fd()), &commonInfo) != nil || dirInfo.Mode&syscall.S_IFMT != syscall.S_IFDIR || commonInfo.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return errors.New("metadata_graph_unavailable")
	}
	if entryInfo.Mode&syscall.S_IFMT == syscall.S_IFDIR {
		if paths.GitEntry != paths.GitDirectory || paths.CommonDirectory != paths.GitDirectory || paths.BacklinkPath != nil || paths.BacklinkRecordPath != nil || entryInfo.Dev != dirInfo.Dev || entryInfo.Ino != dirInfo.Ino || dirInfo.Dev != commonInfo.Dev || dirInfo.Ino != commonInfo.Ino {
			return errors.New("unsupported_metadata_layout")
		}
	} else {
		if paths.BacklinkPath == nil || paths.BacklinkRecordPath == nil || *paths.BacklinkPath != paths.GitEntry || *paths.BacklinkRecordPath != paths.GitDirectory+"/gitdir" ||
			filepath.Dir(paths.GitDirectory) != paths.CommonDirectory+"/worktrees" || entryInfo.Mode&syscall.S_IFMT != syscall.S_IFREG {
			return errors.New("unsupported_metadata_layout")
		}
		if exactMetadataRecord(entry, "gitdir: "+paths.GitDirectory+"\n") != nil || exactMetadataRecord(held[*paths.BacklinkRecordPath], *paths.BacklinkPath+"\n") != nil {
			return errors.New("metadata_association_changed")
		}
		commonRecord, err := openMetadataPath(paths.GitDirectory + "/commondir")
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(paths.GitDirectory, paths.CommonDirectory)
		if err != nil {
			_ = commonRecord.Close()
			return err
		}
		err = exactMetadataRecord(commonRecord, relative+"\n")
		_ = commonRecord.Close()
		if err != nil {
			return errors.New("unsupported_metadata_record")
		}
	}
	identity, err := metadataFingerprint(value, root)
	if err != nil || identity != value.Identity {
		return errors.New("metadata_receipt_changed")
	}
	return nil
}

func exactMetadataRecord(file *os.File, expected string) error {
	if file == nil {
		return errors.New("metadata_record_unavailable")
	}
	if _, err := file.Seek(0, 0); err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(data) > 4096 || !bytes.Equal(data, []byte(expected)) {
		return errors.New("unsupported_metadata_record")
	}
	return nil
}

func metadataFingerprint(value metadataProtection, root *os.File) (string, error) {
	var info syscall.Stat_t
	if syscall.Fstat(int(root.Fd()), &info) != nil {
		return "", errors.New("workspace_identity_unavailable")
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || len(strings.TrimSpace(string(boot))) != 36 {
		return "", errors.New("sandbox_identity_unavailable")
	}
	data, err := json.Marshal(struct {
		Version int             `json:"version"`
		Root    rootIdentity    `json:"root"`
		BootID  string          `json:"bootId"`
		Paths   metadataPaths   `json:"paths"`
		Entries []metadataEntry `json:"entries"`
	}{1, rootIdentity{uint64(info.Dev), info.Ino}, strings.TrimSpace(string(boot)), value.Paths, value.Entries})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return "linux-git-metadata-v1:" + hex.EncodeToString(sum[:]), nil
}
