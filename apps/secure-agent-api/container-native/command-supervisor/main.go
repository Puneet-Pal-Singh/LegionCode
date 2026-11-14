//go:build linux && amd64

// command-supervisor is a physical execution adapter, not an agent or a
// lifecycle producer. Its caller must retain the existing checkout writer until
// the exact receipt and the original transport have both settled.
package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	protocolVersion = 1
	toolHostUID     = 65533
	toolHostGID     = 65533
	controlAddress  = "127.0.0.1:3101"
	maxRequestBytes = 64 * 1024
	maxOutputBytes  = 4 * 1024 * 1024
	privateRoot     = "/run/legioncode/native-commands"
)

type binding struct {
	ExecutionDomainDigest string `json:"executionDomainDigest"`
	SessionID             string `json:"sessionId"`
	LeaseID               string `json:"leaseId"`
	SandboxID             string `json:"sandboxId"`
	Generation            int64  `json:"generation"`
	WorkspaceID           string `json:"workspaceId"`
	RunID                 string `json:"runId"`
	ThreadID              string `json:"threadId"`
	TurnID                string `json:"turnId"`
	RunAttemptID          string `json:"runAttemptId"`
	TaskID                string `json:"taskId"`
	Nonce                 string `json:"nonce"`
}

type rootIdentity struct {
	Device uint64 `json:"device,string"`
	Inode  uint64 `json:"inode,string"`
}

type resourceLimits struct {
	MemoryBytes     uint64 `json:"memoryBytes"`
	Pids            uint64 `json:"pids"`
	CPUQuotaMicros  uint64 `json:"cpuQuotaMicros"`
	CPUPeriodMicros uint64 `json:"cpuPeriodMicros"`
}

type request struct {
	Version        int                `json:"version"`
	Binding        binding            `json:"binding"`
	ControlToken   string             `json:"controlToken"`
	Root           string             `json:"root"`
	ExpectedRoot   rootIdentity       `json:"expectedRoot"`
	ExpectedBootID string             `json:"expectedBootId"`
	Cwd            string             `json:"cwd"`
	Argv           []string           `json:"argv"`
	Environment    map[string]string  `json:"environment"`
	TimeoutMS      int64              `json:"timeoutMs"`
	OutputLimit    int                `json:"outputLimit"`
	Limits         resourceLimits     `json:"limits"`
	Metadata       metadataProtection `json:"metadata"`
}

// Only this non-credential subset crosses into the namespace init process.
type initRequest struct {
	Root        string              `json:"root"`
	RootFS      string              `json:"rootfs"`
	Cwd         string              `json:"cwd"`
	Argv        []string            `json:"argv"`
	Environment map[string]string   `json:"environment"`
	CgroupPath  string              `json:"cgroupPath"`
	Metadata    []initMetadataEntry `json:"metadata"`
}

type namespaceIdentity struct {
	BootID           string         `json:"bootId"`
	NamespaceDevice  uint64         `json:"namespaceDevice,string"`
	NamespaceInode   uint64         `json:"namespaceInode,string"`
	InitHostPID      int            `json:"initHostPid"`
	Root             rootIdentity   `json:"root"`
	Cgroup           rootIdentity   `json:"cgroup"`
	Limits           resourceLimits `json:"limits"`
	MetadataIdentity string         `json:"metadataIdentity"`
}

type receipt struct {
	Version       int                `json:"version"`
	Binding       binding            `json:"binding"`
	State         string             `json:"state"`
	Identity      *namespaceIdentity `json:"identity,omitempty"`
	GateClosed    bool               `json:"gateClosed"`
	Admission     bool               `json:"admission"`
	ExitCode      *int               `json:"exitCode,omitempty"`
	Reason        string             `json:"reason,omitempty"`
	Stdout        []byte             `json:"stdout,omitempty"`
	Stderr        []byte             `json:"stderr,omitempty"`
	OutputLimited bool               `json:"outputLimited"`
}

type initMessage struct {
	Kind     string `json:"kind"`
	Code     string `json:"code,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
}

var opaqueID = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,256}$`)
var hexadecimal = regexp.MustCompile(`^[a-f0-9]{64}$`)

func decodeBounded(reader io.Reader, limit int, value any) error {
	data, err := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
	if err != nil || len(data) > limit {
		return errors.New("invalid_request")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil {
		return errors.New("invalid_request")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid_request")
	}
	return nil
}

func validateRequest(value request) error {
	if !hexadecimal.MatchString(value.Binding.ExecutionDomainDigest) {
		return errors.New("execution_domain_required")
	}
	if value.Version != protocolVersion || !hexadecimal.MatchString(value.ControlToken) ||
		!hexadecimal.MatchString(value.Binding.Nonce) || value.Binding.Generation < 0 {
		return errors.New("invalid_request")
	}
	for _, id := range []string{value.Binding.SessionID, value.Binding.LeaseID, value.Binding.SandboxID, value.Binding.WorkspaceID,
		value.Binding.RunID, value.Binding.ThreadID, value.Binding.TurnID, value.Binding.RunAttemptID, value.Binding.TaskID} {
		if !opaqueID.MatchString(id) {
			return errors.New("invalid_request")
		}
	}
	if !strings.HasPrefix(value.Root, "/home/sandbox/checkouts/") ||
		value.Root == "/home/sandbox/checkouts/" || filepath.Clean(value.Root) != value.Root ||
		strings.ContainsRune(value.Root, 0) || value.ExpectedRoot.Inode == 0 {
		return errors.New("invalid_workspace")
	}
	if value.Cwd == "" || filepath.IsAbs(value.Cwd) || filepath.Clean(value.Cwd) != value.Cwd ||
		value.Cwd == ".." || strings.HasPrefix(value.Cwd, "../") || strings.ContainsRune(value.Cwd, 0) {
		return errors.New("invalid_cwd")
	}
	if len(value.Argv) == 0 || len(value.Argv) > 1024 || value.Argv[0] == "" ||
		value.TimeoutMS < 100 || value.TimeoutMS > 3_600_000 || value.OutputLimit < 1024 || value.OutputLimit > maxOutputBytes {
		return errors.New("invalid_command")
	}
	if value.Limits.MemoryBytes < 64*1024*1024 || value.Limits.MemoryBytes > 1024*1024*1024 ||
		value.Limits.Pids < 16 || value.Limits.Pids > 256 || value.Limits.CPUPeriodMicros != 100_000 ||
		value.Limits.CPUQuotaMicros < 10_000 || value.Limits.CPUQuotaMicros > 100_000 {
		return errors.New("unsupported_resource_limits")
	}
	for _, arg := range value.Argv {
		if len(arg) > 8192 || strings.ContainsRune(arg, 0) {
			return errors.New("invalid_command")
		}
	}
	// Credentials and ambient host variables are never accepted by this port.
	for key, item := range value.Environment {
		if (key != "NODE_ENV" || (item != "test" && item != "development" && item != "production")) &&
			(key != "CI" || (item != "true" && item != "false")) {
			return errors.New("unsupported_environment")
		}
	}
	return nil
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--provision-resources" {
		if provisionResources() != nil {
			_, _ = io.WriteString(os.Stderr, "native_resource_provisioning_unavailable\n")
			os.Exit(70)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--write-workspace-file" {
		if writeWorkspaceFile() != nil {
			_, _ = io.WriteString(os.Stderr, "native_workspace_write_unavailable\n")
			os.Exit(70)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--prepare-workspace" {
		if prepareWorkspace() != nil {
			_, _ = io.WriteString(os.Stderr, "native_workspace_preparation_unavailable\n")
			os.Exit(70)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--namespace-init" {
		os.Exit(runNamespaceInit())
	}
	if len(os.Args) == 3 && strings.HasPrefix(os.Args[1], "--qualification-") {
		os.Exit(runQualificationPayload(os.Args[1], os.Args[2]))
	}
	if len(os.Args) != 2 || (os.Args[1] != "--serve" && os.Args[1] != "--qualify") {
		// No implicit probe, software installation, alternate backend or execution.
		_, _ = io.WriteString(os.Stderr, "command_supervisor_requires_explicit_serve\n")
		os.Exit(64)
	}
	var input request
	if err := decodeBounded(os.Stdin, maxRequestBytes, &input); err != nil {
		_, _ = io.WriteString(os.Stderr, "invalid_request\n")
		os.Exit(64)
	}
	if os.Args[1] == "--qualify" {
		// Explicit disposable-workspace execution, never a health-check side
		// effect. It still requires the same persisted intent and creator gate.
		input.Argv = []string{"/usr/local/libexec/legioncode-command-supervisor", "--qualification-payload", input.Binding.Nonce}
		input.Cwd, input.Environment = ".", nil
	}
	if err := validateRequest(input); err != nil {
		_, _ = io.WriteString(os.Stderr, err.Error()+"\n")
		os.Exit(64)
	}
	if err := serveCommand(input); err != nil {
		// Never log argv, paths, environment, tokens or arbitrary operating errors.
		_, _ = io.WriteString(os.Stderr, "command_supervisor_unavailable\n")
		os.Exit(70)
	}
}
