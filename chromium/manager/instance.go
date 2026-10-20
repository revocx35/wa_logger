package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	errTooMany  = errors.New("too many browser instances")
	errNotReady = errors.New("browser did not become ready")
)

type Config struct {
	Layout       Layout
	Width        int
	Height       int
	MaxInstances int
	ChromiumBin  string
	NoSandbox    bool
	Debug        bool
}

// Backend is what the HTTP layer needs from the process supervisor (faked in tests).
type Backend interface {
	// Ensure starts the instance if needed and waits until Chromium's DevTools endpoint answers.
	Ensure(ctx context.Context, id int) error
	Restart(ctx context.Context, id int) error
	// Delete stops the instance and removes everything it owns (profile included).
	Delete(ctx context.Context, id int) error
	// Ports of a running instance (loopback only).
	Endpoints(id int) (cdpPort, vncPort int, vncPassword string, ok bool)
	Stopped() <-chan struct{}
	Shutdown()
}

// Manager runs one Xvfb + Chromium + x11vnc trio per instance, each under the instance's own unix user.
type Manager struct {
	cfg Config

	mu        sync.Mutex
	instances map[int]*Instance
	stopped   chan struct{}
	once      sync.Once
}

func NewManager(cfg Config) *Manager {
	return &Manager{cfg: cfg, instances: map[int]*Instance{}, stopped: make(chan struct{})}
}

func (m *Manager) Stopped() <-chan struct{} { return m.stopped }

type Instance struct {
	id  int
	m   *Manager
	mu  sync.Mutex // serializes start/stop of this instance
	run *running
}

type running struct {
	cancel      context.CancelFunc
	done        chan struct{} // closed when every supervisor goroutine has finished
	cdpPort     int
	vncPort     int
	vncPassword string
}

func (m *Manager) instance(id int, create bool) (*Instance, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if in, ok := m.instances[id]; ok {
		return in, nil
	}
	if !create {
		return nil, nil
	}
	if len(m.instances) >= m.cfg.MaxInstances {
		return nil, errTooMany
	}
	in := &Instance{id: id, m: m}
	m.instances[id] = in
	return in, nil
}

func (m *Manager) Endpoints(id int) (int, int, string, bool) {
	in, _ := m.instance(id, false)
	if in == nil {
		return 0, 0, "", false
	}
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.run == nil {
		return 0, 0, "", false
	}
	return in.run.cdpPort, in.run.vncPort, in.run.vncPassword, true
}

func (m *Manager) Ensure(ctx context.Context, id int) error {
	in, err := m.instance(id, true)
	if err != nil {
		return err
	}
	in.mu.Lock()
	if in.run == nil {
		if err := in.start(); err != nil {
			in.mu.Unlock()
			return err
		}
	}
	cdp := in.run.cdpPort
	in.mu.Unlock()
	return waitCDP(ctx, cdp)
}

func (m *Manager) Restart(ctx context.Context, id int) error {
	in, err := m.instance(id, true)
	if err != nil {
		return err
	}
	in.mu.Lock()
	in.stop()
	err = in.start()
	cdp := 0
	if err == nil {
		cdp = in.run.cdpPort
	}
	in.mu.Unlock()
	if err != nil {
		return err
	}
	return waitCDP(ctx, cdp)
}

func (m *Manager) Delete(ctx context.Context, id int) error {
	in, _ := m.instance(id, false)
	if in != nil {
		in.mu.Lock()
		in.stop()
		in.mu.Unlock()
	}
	m.mu.Lock()
	delete(m.instances, id)
	m.mu.Unlock()
	return m.removeFiles(id)
}

func (m *Manager) Shutdown() {
	m.once.Do(func() {
		m.mu.Lock()
		list := make([]*Instance, 0, len(m.instances))
		for _, in := range m.instances {
			list = append(list, in)
		}
		m.mu.Unlock()
		var wg sync.WaitGroup
		for _, in := range list {
			wg.Add(1)
			go func(in *Instance) {
				defer wg.Done()
				in.mu.Lock()
				in.stop()
				in.mu.Unlock()
			}(in)
		}
		wg.Wait()
		close(m.stopped)
	})
}

/* ------------------------------------------------------------ one instance */

func (in *Instance) start() error {
	l := in.m.cfg.Layout
	id := in.id
	if err := in.m.prepareDirs(id); err != nil {
		return fmt.Errorf("prepare: %w", err)
	}
	display := l.Display(id)
	auth, err := xauthority(display)
	if err != nil {
		return err
	}
	runDir := l.RunPath(id)
	authFile := filepath.Join(runDir, "Xauthority")
	if err := in.m.writeAs(id, authFile, auth); err != nil {
		return err
	}
	pw := randomPassword()
	pwFile := filepath.Join(runDir, "vncpw")
	if err := in.m.writeAs(id, pwFile, []byte(pw)); err != nil {
		return err
	}
	cdpPort, err := freePort()
	if err != nil {
		return err
	}
	vncPort, err := freePort()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &running{cancel: cancel, done: make(chan struct{}), cdpPort: cdpPort, vncPort: vncPort, vncPassword: pw}
	env := in.m.childEnv(id, display, authFile)
	cfg := in.m.cfg
	xsock := fmt.Sprintf("/tmp/.X11-unix/X%d", display)

	var wg sync.WaitGroup
	spawn := func(name string, build func() (string, []string, bool)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			in.m.supervise(ctx, id, name, env, build)
		}()
	}
	spawn("xvfb", func() (string, []string, bool) {
		_ = os.Remove(xsock)
		return "Xvfb", []string{
			":" + strconv.Itoa(display), "-screen", "0", fmt.Sprintf("%dx%dx24", cfg.Width, cfg.Height),
			"-nolisten", "tcp", "-nolisten", "local", "-auth", authFile, "-dpi", "96", "+extension", "RANDR",
		}, true
	})
	spawn("chromium", func() (string, []string, bool) {
		if !waitFor(ctx, func() bool { _, err := os.Stat(xsock); return err == nil }, 10*time.Second) {
			return "", nil, false
		}
		profile := l.ProfileDir(id)
		for _, f := range []string{"SingletonLock", "SingletonSocket", "SingletonCookie"} {
			_ = os.Remove(filepath.Join(profile, f)) // a crash can leave the profile locked; only this instance uses it
		}
		args := []string{
			"--user-data-dir=" + profile,
			"--remote-debugging-port=" + strconv.Itoa(cdpPort),
			"--kiosk", "--no-first-run", "--no-default-browser-check", "--password-store=basic",
			"--disable-features=Translate,MediaRouter,DialMediaRouteProvider",
			"--disable-component-update", "--noerrdialogs", "--hide-crash-restore-bubble", "--disable-session-crashed-bubble",
			"--lang=en-US", "--force-device-scale-factor=1",
			// Calls need WhatsApp Web's audio to run without a human click, also in a popout nobody clicks into.
			"--autoplay-policy=no-user-gesture-required",
			// Video calls move into a popout window, which hides the WhatsApp tab; hidden tabs would be throttled.
			"--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
			"--window-position=0,0", fmt.Sprintf("--window-size=%d,%d", cfg.Width, cfg.Height),
		}
		if cfg.NoSandbox {
			log.Printf("WARNING: CHROMIUM_NO_SANDBOX=1 — the sandbox of instance %d is DISABLED. Fix the seccomp profile instead.", id)
			args = append(args, "--no-sandbox")
		}
		return cfg.ChromiumBin, append(args, "about:blank"), true
	})
	spawn("x11vnc", func() (string, []string, bool) {
		if !waitFor(ctx, func() bool { _, err := os.Stat(xsock); return err == nil }, 10*time.Second) {
			return "", nil, false
		}
		return "x11vnc", []string{
			"-display", ":" + strconv.Itoa(display), "-auth", authFile,
			"-rfbport", strconv.Itoa(vncPort), "-listen", "127.0.0.1", "-localhost", "-noipv6",
			"-passwdfile", "read:" + pwFile,
			"-forever", "-shared", "-noxdamage", "-nowf", "-quiet",
		}, true
	})
	go func() {
		wg.Wait()
		close(r.done)
	}()
	in.run = r
	return nil
}

// stop terminates the instance's processes (Chromium first, so it can flush the profile) and waits for them.
func (in *Instance) stop() {
	r := in.run
	if r == nil {
		return
	}
	in.run = nil
	r.cancel()
	<-r.done
}

// supervise keeps one process running until ctx ends. build may return ok=false to skip a round.
func (m *Manager) supervise(ctx context.Context, id int, name string, env []string, build func() (string, []string, bool)) {
	for ctx.Err() == nil {
		bin, args, ok := build()
		if ok {
			cmd := m.command(id, bin, args, env)
			if m.cfg.Debug {
				cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
			}
			if err := cmd.Start(); err != nil {
				log.Printf("instance %d: %s failed to start: %v", id, name, err)
			} else {
				exited := make(chan error, 1)
				go func() { exited <- cmd.Wait() }()
				select {
				case err := <-exited:
					log.Printf("instance %d: %s exited (%v); restarting in 2s", id, name, err)
				case <-ctx.Done():
					terminate(cmd, exited)
					return
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

// terminate asks the process group to stop and kills it after a grace period.
func terminate(cmd *exec.Cmd, exited <-chan error) {
	pgid := cmd.Process.Pid
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	select {
	case <-exited:
	case <-time.After(12 * time.Second):
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		<-exited
	}
	_ = syscall.Kill(-pgid, syscall.SIGKILL) // stragglers (Chromium helpers)
}

/* --------------------------------------------------------------- helpers */

// command builds a command that runs as the instance's unix user (when we are root) in its own process group.
func (m *Manager) command(id int, bin string, args, env []string) *exec.Cmd {
	cmd := exec.Command(bin, args...)
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if os.Geteuid() == 0 {
		cmd.SysProcAttr.Credential = &syscall.Credential{Uid: uint32(m.cfg.Layout.UID(id)), Gid: uint32(m.cfg.Layout.GID(id))}
	}
	cmd.Dir = m.cfg.Layout.Home(id)
	return cmd
}

// childEnv is built from scratch: nothing of the manager's own environment (the control secret!) reaches a browser.
func (m *Manager) childEnv(id, display int, authFile string) []string {
	l := m.cfg.Layout
	return []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=" + l.Home(id),
		"TMPDIR=" + l.Tmp(id),
		"DISPLAY=:" + strconv.Itoa(display),
		"XAUTHORITY=" + authFile,
		"DBUS_SESSION_BUS_ADDRESS=disabled:",
		"LANG=en_US.UTF-8",
	}
}

// prepareDirs creates the instance's directories, owned by its own unix user and closed to everyone else. The manager
// has CAP_CHOWN but no DAC override: it creates and hands over the top-level directories (their parents are its own),
// everything inside is created by the instance's user itself.
func (m *Manager) prepareDirs(id int) error {
	l := m.cfg.Layout
	uid, gid := l.UID(id), l.GID(id)
	for _, d := range []string{l.DataRoot(id), l.RunPath(id), l.Home(id), l.Tmp(id)} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
		if err := os.Chown(d, uid, gid); err != nil && os.Geteuid() == 0 {
			return err
		}
	}
	if err := m.runAs(id, nil, "mkdir", "-p", "-m", "0700", l.ProfileDir(id)); err != nil {
		return err
	}
	// The X socket directory is shared (sticky, world-writable like the real /tmp/.X11-unix).
	if err := os.MkdirAll("/tmp/.X11-unix", 0o1777); err == nil {
		_ = os.Chmod("/tmp/.X11-unix", 0o1777)
	}
	return nil
}

// runAs runs a helper command as the instance's unix user.
func (m *Manager) runAs(id int, stdin []byte, bin string, args ...string) error {
	cmd := m.command(id, bin, args, []string{"PATH=/usr/bin:/bin"})
	cmd.Dir = "/"
	if stdin != nil {
		cmd.Stdin = strings.NewReader(string(stdin))
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s: %v: %s", bin, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// writeAs writes a 0600 file as the instance's unix user (its directory is closed to everyone else, root included).
func (m *Manager) writeAs(id int, path string, data []byte) error {
	return m.runAs(id, data, "sh", "-c", `umask 077 && cat > "$1"`, "sh", path)
}

// removeFiles deletes everything an instance owns. Files inside are owned by the instance's user and the manager
// holds no DAC override, so the emptying runs as that user; the (root-owned) parents are removed afterwards.
func (m *Manager) removeFiles(id int) error {
	l := m.cfg.Layout
	var firstErr error
	for _, d := range []string{l.DataRoot(id), l.RunPath(id), l.Home(id), l.Tmp(id)} {
		if _, err := os.Lstat(d); err != nil {
			continue
		}
		cmd := m.command(id, "find", []string{d, "-mindepth", "1", "-delete"}, []string{"PATH=/usr/bin:/bin"})
		cmd.Dir = "/"
		if out, err := cmd.CombinedOutput(); err != nil && firstErr == nil {
			firstErr = fmt.Errorf("emptying %s: %v: %s", d, err, strings.TrimSpace(string(out)))
		}
		if id != 1 || d != l.DataRoot(1) {
			_ = os.Remove(d)
		}
	}
	_ = os.Remove(filepath.Join("/tmp/.X11-unix", fmt.Sprintf("X%d", l.Display(id))))
	return firstErr
}

func randomPassword() string {
	b := make([]byte, 12)
	_, _ = io.ReadFull(rand.Reader, b)
	return strings.NewReplacer("-", "A", "_", "B").Replace(base64.RawURLEncoding.EncodeToString(b))[:8]
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func waitFor(ctx context.Context, ok func() bool, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return false
		}
		if ok() {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

func waitCDP(ctx context.Context, port int) error {
	client := &http.Client{Timeout: 2 * time.Second}
	url := fmt.Sprintf("http://127.0.0.1:%d/json/version", port)
	for {
		if resp, err := client.Get(url); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return errNotReady
		case <-time.After(250 * time.Millisecond):
		}
	}
}
