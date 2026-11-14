//go:build linux && amd64

package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

type supervisor struct {
	mu       sync.Mutex
	input    request
	current  receipt
	gate     *os.File
	pidfd    int
	nsfd     *os.File
	domain   *commandDomain
	gateOnce sync.Once
	ackOnce  sync.Once
	ack      chan struct{}
	started  chan struct{}
}

type controlRequest struct {
	Binding  binding            `json:"binding"`
	Identity *namespaceIdentity `json:"identity,omitempty"`
}

func serveCommand(input request) error {
	if err := requireToolIdentity(); err != nil {
		return err
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || input.ExpectedBootID == "" || strings.TrimSpace(string(boot)) != input.ExpectedBootID {
		return errors.New("sandbox_generation_changed")
	}
	root, err := openHeldWorkspace(input.Root, input.ExpectedRoot)
	if err != nil {
		return err
	}
	defer root.Close()
	if err := verifyHeldCwd(root, input.Cwd); err != nil {
		return err
	}
	var metadata []*os.File
	if input.Binding.Qualification != nil {
		if validateQualificationFixture(input) != nil {
			return errors.New("qualification_fixture_changed")
		}
	} else {
		if input.Metadata.Paths.WorkspaceRoot != input.Root {
			return errors.New("metadata_scope_changed")
		}
		metadata, err = pinMetadata(input.Metadata, root)
		if err != nil {
			return err
		}
	}
	defer func() {
		for _, file := range metadata {
			_ = file.Close()
		}
	}()

	domain, err := prepareCommandDomain(input)
	if err != nil {
		return err
	}
	defer domain.file.Close()
	defer domain.parent.Close()
	beforeBirth := true
	defer func() {
		if beforeBirth {
			_ = domain.removeEmpty()
		}
	}()
	if err := preparePrivateDirectory(privateRoot); err != nil {
		return err
	}
	directory, err := os.MkdirTemp(privateRoot, input.Binding.Nonce+"-")
	if err != nil {
		return err
	}
	// Only host-created empty directories are removed. Never recurse through a
	// selected checkout, including on an initialization failure.
	defer os.Remove(directory)
	rootfs := directory + "/rootfs"
	if err := os.Mkdir(rootfs, 0700); err != nil {
		return err
	}
	defer os.Remove(rootfs)
	listener, err := net.Listen("tcp4", controlAddress)
	if err != nil {
		return err
	}
	owner := &supervisor{input: input, domain: domain, pidfd: -1, ack: make(chan struct{}), started: make(chan struct{}),
		current: receipt{Version: protocolVersion, Binding: input.Binding, State: "preparing"}}
	server := &http.Server{Handler: owner, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 5 * time.Second, WriteTimeout: 10 * time.Second, MaxHeaderBytes: 4096,
		ErrorLog: log.New(io.Discard, "", 0)}
	defer server.Close()
	go func() { _ = server.Serve(listener) }()
	stopSignals := make(chan os.Signal, 1)
	signal.Notify(stopSignals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer signal.Stop(stopSignals)
	go func() {
		select {
		case <-stopSignals:
			owner.stop("supervisor_stop")
		case <-owner.ack:
		}
	}()
	// From this point a failure retains the exact domain for reconciliation;
	// only explicit settled-receipt ACK below may remove it.
	beforeBirth = false
	if err := owner.execute(root, rootfs, metadata); err != nil {
		return err
	}
	// The owner first saves this exact closed receipt in the existing session
	// record. Only its explicit ACK may finish the original exec HTTP body.
	<-owner.ack
	value := owner.snapshot()
	if value.State != "closed" && value.State != "not_started" {
		return errors.New("closure_unknown")
	}
	if err := domain.removeEmpty(); err != nil {
		return errors.New("resource_cleanup_unconfirmed")
	}
	if err := json.NewEncoder(os.Stdout).Encode(value); err != nil {
		return errors.New("transport_unsettled")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return server.Shutdown(ctx)
}

func (owner *supervisor) snapshot() receipt {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	result := owner.current
	result.Stdout = append([]byte(nil), result.Stdout...)
	result.Stderr = append([]byte(nil), result.Stderr...)
	return result
}

func (owner *supervisor) ServeHTTP(writer http.ResponseWriter, incoming *http.Request) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	if subtle.ConstantTimeCompare([]byte(incoming.Header.Get("Authorization")), []byte("Bearer "+owner.input.ControlToken)) != 1 ||
		incoming.Method != http.MethodPost {
		writer.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(writer, `{"code":"control_rejected"}`)
		return
	}
	var command controlRequest
	if decodeBounded(incoming.Body, 4096, &command) != nil || !sameBinding(command.Binding, owner.input.Binding) {
		writer.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(writer, `{"code":"scope_changed"}`)
		return
	}
	owner.mu.Lock()
	identityMatches := command.Identity != nil && owner.current.Identity != nil && *command.Identity == *owner.current.Identity
	owner.mu.Unlock()
	switch incoming.URL.Path {
	case "/v1/status":
	case "/v1/start":
		if !identityMatches || !owner.start() {
			writer.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(writer, `{"code":"start_rejected"}`)
			return
		}
	case "/v1/stop":
		owner.stop("user_stop")
	case "/v1/ack":
		owner.mu.Lock()
		settled := owner.current.State == "closed" || owner.current.State == "not_started"
		owner.mu.Unlock()
		if !settled || (!identityMatches && owner.snapshot().Identity != nil) {
			writer.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(writer, `{"code":"closure_unconfirmed"}`)
			return
		}
		owner.ackOnce.Do(func() { close(owner.ack) })
	default:
		writer.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(writer, `{"code":"control_unavailable"}`)
		return
	}
	_ = json.NewEncoder(writer).Encode(owner.snapshot())
}

func (owner *supervisor) start() bool {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.current.State == "running" && owner.current.Admission {
		return true // Idempotent observation of the same creator gate.
	}
	if owner.input.Binding.Qualification != nil && owner.input.Binding.Qualification.ExpiresAt <= time.Now().UnixMilli() {
		return false
	}
	if owner.current.State != "prepared" || owner.current.GateClosed || owner.pidfd < 0 || owner.gate == nil {
		return false
	}
	owner.gateOnce.Do(func() {
		owner.current.GateClosed = true
		count, err := owner.gate.Write([]byte{1})
		owner.current.Admission = count > 0
		_ = owner.gate.Close()
		if err != nil || count != 1 {
			owner.current.State, owner.current.Reason = "stopping", "creator_gate_unavailable"
			return
		}
		owner.current.State = "running"
		close(owner.started)
	})
	return owner.current.Admission
}

func (owner *supervisor) stop(reason string) {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.current.State == "closed" || owner.current.State == "not_started" {
		return
	}
	owner.gateOnce.Do(func() {
		owner.current.GateClosed = true
		if owner.gate != nil {
			_ = owner.gate.Close()
		}
	})
	owner.current.State, owner.current.Reason = "stopping", reason
	// This closes the complete bounded domain, including namespace members
	// which detached or stopped holding the original output pipes.
	if owner.domain == nil || owner.domain.kill() != nil {
		owner.current.State, owner.current.Reason = "unknown", "resource_signal_unconfirmed"
	}
	if owner.pidfd >= 0 {
		if err := signalPIDFD(owner.pidfd, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
			owner.current.State, owner.current.Reason = "unknown", "namespace_signal_unconfirmed"
		}
	}
}

func (owner *supervisor) execute(workspace *os.File, rootfs string, metadata []*os.File) error {
	// Pdeathsig is tied to the creating OS thread. Keep that thread alive until
	// the namespace init has been waited, rather than relying on a Go goroutine.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	configRead, configWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer configRead.Close()
	defer configWrite.Close()
	gateRead, gateWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer gateRead.Close()
	defer gateWrite.Close()
	statusRead, statusWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer statusRead.Close()
	defer statusWrite.Close()
	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer stdoutRead.Close()
	defer stdoutWrite.Close()
	stderrRead, stderrWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer stderrRead.Close()
	defer stderrWrite.Close()
	owner.mu.Lock()
	owner.gate = gateWrite
	alreadyStopped := owner.current.GateClosed
	owner.mu.Unlock()
	if alreadyStopped {
		owner.mu.Lock()
		owner.current.State = "not_started"
		owner.mu.Unlock()
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	initPIDFD := -1
	child := exec.Command(executable, "--namespace-init")
	child.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"}
	child.ExtraFiles = []*os.File{configRead, gateRead, statusWrite, workspace}
	child.ExtraFiles = append(child.ExtraFiles, metadata...)
	child.Stdout, child.Stderr = stdoutWrite, stderrWrite
	child.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags:                 syscall.CLONE_NEWUSER | syscall.CLONE_NEWPID | syscall.CLONE_NEWNS | syscall.CLONE_NEWNET | syscall.CLONE_NEWIPC | syscall.CLONE_NEWUTS,
		UidMappings:                []syscall.SysProcIDMap{{ContainerID: 0, HostID: 0, Size: 1}, {ContainerID: 1, HostID: toolHostUID, Size: 1}},
		GidMappings:                []syscall.SysProcIDMap{{ContainerID: 0, HostID: 0, Size: 1}, {ContainerID: 1, HostID: toolHostGID, Size: 1}},
		GidMappingsEnableSetgroups: true,
		Credential:                 &syscall.Credential{Uid: 0, Gid: 0, Groups: []uint32{}},
		Pdeathsig:                  syscall.SIGKILL, PidFD: &initPIDFD,
		// Go uses clone3(CLONE_INTO_CGROUP) when UseCgroupFD is set. It
		// returns an error on unsupported/denied clone3; no clone fallback or
		// post-birth cgroup.procs migration is permitted.
		UseCgroupFD: true, CgroupFD: int(owner.domain.file.Fd()),
	}
	if owner.input.Binding.Qualification != nil && owner.input.Binding.Qualification.ExpiresAt <= time.Now().UnixMilli() {
		return errors.New("qualification_grant_expired")
	}
	if err := child.Start(); err != nil {
		owner.mu.Lock()
		owner.current.State, owner.current.Reason, owner.current.GateClosed = "not_started", "namespace_unavailable", true
		owner.mu.Unlock()
		return nil
	}
	_ = configRead.Close()
	_ = gateRead.Close()
	_ = statusWrite.Close()
	_ = stdoutWrite.Close()
	_ = stderrWrite.Close()
	owner.mu.Lock()
	owner.pidfd = initPIDFD
	stoppedDuringBirth := owner.current.GateClosed
	owner.mu.Unlock()
	if stoppedDuringBirth {
		owner.stop("stop_during_preparation")
	}
	if initPIDFD >= 0 {
		defer func() {
			owner.mu.Lock()
			owner.pidfd = -1
			owner.mu.Unlock()
			_ = syscall.Close(initPIDFD)
		}()
	}
	identity, identityErr := readNamespaceIdentity(child.Process.Pid, owner.input.ExpectedRoot)
	if identityErr == nil {
		identity.value.Cgroup, identity.value.Limits = owner.domain.identity, owner.domain.limits
		identity.value.MetadataIdentity = owner.input.Metadata.Identity
		owner.mu.Lock()
		owner.current.Identity, owner.nsfd = identity.value, identity.file
		owner.mu.Unlock()
		defer func() {
			owner.mu.Lock()
			owner.nsfd = nil
			owner.mu.Unlock()
			_ = identity.file.Close()
		}()
	}
	if initPIDFD < 0 || identityErr != nil {
		owner.stop("namespace_identity_unavailable")
	}
	config := initRequest{Root: owner.input.Root, RootFS: rootfs, Cwd: owner.input.Cwd, Argv: owner.input.Argv, Environment: owner.input.Environment, CgroupPath: commandCgroupPath + owner.input.Binding.Nonce}
	for index, entry := range owner.input.Metadata.Entries {
		config.Metadata = append(config.Metadata, initMetadataEntry{metadataEntry: entry, Descriptor: 7 + index})
	}
	if err := json.NewEncoder(configWrite).Encode(config); err != nil {
		owner.stop("namespace_configuration_unavailable")
	}
	_ = configWrite.Close()
	stdoutDone, stderrDone, statusDone := make(chan error, 1), make(chan error, 1), make(chan error, 1)
	go func() { stdoutDone <- owner.capture(stdoutRead, false) }()
	go func() { stderrDone <- owner.capture(stderrRead, true) }()
	go func() { statusDone <- owner.readInitMessages(statusRead) }()
	lifetimeDone := make(chan struct{})
	defer close(lifetimeDone)
	go func() {
		timer := time.NewTimer(15 * time.Second)
		defer timer.Stop()
		select {
		case <-owner.started:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(time.Duration(owner.input.TimeoutMS) * time.Millisecond)
		case <-timer.C:
			owner.stop("preparation_deadline")
			return
		case <-lifetimeDone:
			return
		}
		select {
		case <-timer.C:
			owner.stop("command_deadline")
		case <-lifetimeDone:
		}
	}()
	// For a real PID-namespace init, wait completes after kernel namespace
	// teardown. Never replace this with killpg, a PID absence check, or timeout.
	waitErr := child.Wait()
	var exited *exec.ExitError
	positiveWait := child.ProcessState != nil && (waitErr == nil || errors.As(waitErr, &exited))
	if positiveWait {
		status, ok := child.ProcessState.Sys().(syscall.WaitStatus)
		positiveWait = ok && (status.Exited() || status.Signaled())
	}
	stdoutErr, stderrErr, statusErr := <-stdoutDone, <-stderrDone, <-statusDone
	// A successful init wait alone is insufficient for the resource receipt.
	// Hold the actual cgroup descriptor and require a kernel population result.
	empty, resourceErr := owner.domain.empty()
	if resourceErr == nil && !empty {
		_ = owner.domain.kill()
		// No timed-out population check may produce a closed receipt.
		deadline := time.Now().Add(time.Second)
		for !empty && resourceErr == nil && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
			empty, resourceErr = owner.domain.empty()
		}
	}
	owner.mu.Lock()
	defer owner.mu.Unlock()
	owner.gateOnce.Do(func() {
		if owner.gate != nil {
			_ = owner.gate.Close()
		}
		owner.current.GateClosed = true
	})
	if !positiveWait || stdoutErr != nil || stderrErr != nil || statusErr != nil {
		owner.current.State, owner.current.Reason = "unknown", "original_output_unsettled"
		return nil
	}
	if resourceErr != nil || !empty {
		owner.current.State, owner.current.Reason = "unknown", "resource_closure_unconfirmed"
		return nil
	}
	owner.current.State = "closed"
	if owner.current.Admission && owner.current.ExitCode == nil && owner.current.Reason == "" {
		owner.current.Reason = "foreground_outcome_unavailable"
	}
	if !owner.current.Admission {
		owner.current.State = "not_started"
	}
	return nil
}

func (owner *supervisor) capture(reader io.Reader, stderr bool) error {
	buffer := make([]byte, 32*1024)
	for {
		count, err := reader.Read(buffer)
		limited := false
		if count > 0 {
			owner.mu.Lock()
			remaining := owner.input.OutputLimit - len(owner.current.Stdout) - len(owner.current.Stderr)
			keep := count
			if keep > remaining {
				keep = remaining
				limited = true
				owner.current.OutputLimited = true
			}
			if stderr {
				owner.current.Stderr = append(owner.current.Stderr, buffer[:keep]...)
			} else {
				owner.current.Stdout = append(owner.current.Stdout, buffer[:keep]...)
			}
			owner.mu.Unlock()
		}
		if limited {
			owner.stop("output_limit")
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			owner.stop("output_unavailable")
			return err
		}
	}
}

func (owner *supervisor) readInitMessages(reader io.Reader) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 1024), 4096)
	seenPrepared, seenTerminal := false, false
	for scanner.Scan() {
		var message initMessage
		if decodeBounded(strings.NewReader(scanner.Text()), 4096, &message) != nil {
			owner.stop("init_protocol_invalid")
			return errors.New("init_protocol_invalid")
		}
		owner.mu.Lock()
		switch message.Kind {
		case "prepared":
			if seenPrepared || owner.current.Identity == nil || owner.pidfd < 0 {
				owner.mu.Unlock()
				owner.stop("init_protocol_invalid")
				return errors.New("init_protocol_invalid")
			}
			seenPrepared = true
			if !owner.current.GateClosed {
				owner.current.State = "prepared"
			}
		case "foreground_exit":
			if !seenPrepared || seenTerminal || !owner.current.Admission || message.ExitCode == nil {
				owner.mu.Unlock()
				owner.stop("init_protocol_invalid")
				return errors.New("init_protocol_invalid")
			}
			seenTerminal = true
			owner.current.ExitCode = message.ExitCode
		case "rejected":
			if seenTerminal {
				owner.mu.Unlock()
				owner.stop("init_protocol_invalid")
				return errors.New("init_protocol_invalid")
			}
			seenTerminal = true
			owner.current.Reason = "namespace_setup_rejected"
		default:
			owner.mu.Unlock()
			owner.stop("init_protocol_invalid")
			return errors.New("init_protocol_invalid")
		}
		owner.mu.Unlock()
	}
	return scanner.Err()
}

type heldNamespaceIdentity struct {
	value *namespaceIdentity
	file  *os.File
}

func readNamespaceIdentity(pid int, root rootIdentity) (heldNamespaceIdentity, error) {
	file, err := os.Open(fmt.Sprintf("/proc/%d/ns/pid", pid))
	if err != nil {
		return heldNamespaceIdentity{}, err
	}
	var info syscall.Stat_t
	if syscall.Fstat(int(file.Fd()), &info) != nil {
		file.Close()
		return heldNamespaceIdentity{}, errors.New("namespace_unavailable")
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || len(strings.TrimSpace(string(boot))) != 36 {
		file.Close()
		return heldNamespaceIdentity{}, errors.New("boot_identity_unavailable")
	}
	return heldNamespaceIdentity{value: &namespaceIdentity{BootID: strings.TrimSpace(string(boot)), NamespaceDevice: uint64(info.Dev), NamespaceInode: info.Ino, InitHostPID: pid, Root: root}, file: file}, nil
}

func signalPIDFD(fd int, value syscall.Signal) error {
	_, _, errno := syscall.Syscall6(424, uintptr(fd), uintptr(value), 0, 0, 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}
