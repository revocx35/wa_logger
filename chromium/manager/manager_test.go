package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

var secret = []byte("control-secret-for-tests")

type fakeBackend struct {
	cdp, vnc int
	running  map[int]bool
	ensured  []int
	deleted  []int
}

func (f *fakeBackend) Ensure(ctx context.Context, id int) error {
	f.ensured = append(f.ensured, id)
	f.running[id] = true
	return nil
}
func (f *fakeBackend) Restart(ctx context.Context, id int) error { return f.Ensure(ctx, id) }
func (f *fakeBackend) Delete(ctx context.Context, id int) error {
	f.deleted = append(f.deleted, id)
	delete(f.running, id)
	return nil
}
func (f *fakeBackend) Endpoints(id int) (int, int, string, bool) {
	if !f.running[id] {
		return 0, 0, "", false
	}
	return f.cdp, f.vnc, "pw123456", true
}
func (f *fakeBackend) Stopped() <-chan struct{} { return nil }
func (f *fakeBackend) Shutdown()                {}

func do(t *testing.T, h http.Handler, method, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestTokensAreInstanceBound(t *testing.T) {
	if instanceToken(secret, 2) == instanceToken(secret, 3) {
		t.Fatal("tokens of different instances must differ")
	}
	if instanceToken(secret, 2) == adminToken(secret) {
		t.Fatal("instance and admin tokens must differ")
	}
	if instanceToken([]byte("another secret"), 2) == instanceToken(secret, 2) {
		t.Fatal("tokens depend on the secret")
	}
}

// The app container's supervisor derives the same tokens in TypeScript (server/src/supervisor/tokens.ts); both sides
// are pinned to the same vectors (HMAC-SHA256, hex).
func TestTokenVectors(t *testing.T) {
	s := []byte("testsecret-0123456789")
	if got := instanceToken(s, 1); got != "af32b993f73045e8bec51dc96ecc7e9acbbce97cc660fc59f1921c9776da61b4" {
		t.Fatalf("instance 1: %s", got)
	}
	if got := instanceToken(s, 42); got != "abfb541b0c05f1b614fb1b873b0ea66adb2899b988896c8fae8d1cf72ac69d9b" {
		t.Fatalf("instance 42: %s", got)
	}
	if got := adminToken(s); got != "13215f4dc7bdb42e0431274d3f633d8b18e140d96778be5dac054e858fd256f4" {
		t.Fatalf("admin: %s", got)
	}
}

func TestAuthorization(t *testing.T) {
	fb := &fakeBackend{running: map[int]bool{}}
	h := NewHandler(fb, secret)

	if rec := do(t, h, "POST", "/i/2/ensure", ""); rec.Code != 401 {
		t.Fatalf("no token: %d", rec.Code)
	}
	if rec := do(t, h, "POST", "/i/2/ensure", "garbage"); rec.Code != 401 {
		t.Fatalf("bad token: %d", rec.Code)
	}
	// Tenant 3's token must not open tenant 2.
	if rec := do(t, h, "POST", "/i/2/ensure", instanceToken(secret, 3)); rec.Code != 401 {
		t.Fatalf("other tenant's token: %d", rec.Code)
	}
	if len(fb.ensured) != 0 {
		t.Fatal("nothing must have been started")
	}
	if rec := do(t, h, "POST", "/i/2/ensure", instanceToken(secret, 2)); rec.Code != 200 {
		t.Fatalf("own token: %d", rec.Code)
	}
	// Deleting needs the admin token, not even the tenant's own.
	if rec := do(t, h, "DELETE", "/i/2", instanceToken(secret, 2)); rec.Code != 401 {
		t.Fatalf("tenant deleting itself: %d", rec.Code)
	}
	if rec := do(t, h, "DELETE", "/i/2", adminToken(secret)); rec.Code != 200 || len(fb.deleted) != 1 {
		t.Fatalf("admin delete: %d %v", rec.Code, fb.deleted)
	}
	for _, id := range []string{"0", "10000", "-1", "abc", "1x"} {
		if rec := do(t, h, "POST", "/i/"+id+"/ensure", adminToken(secret)); rec.Code != 404 {
			t.Fatalf("id %q: %d", id, rec.Code)
		}
	}
	if rec := do(t, h, "GET", "/healthz", ""); rec.Code != 200 {
		t.Fatalf("healthz: %d", rec.Code)
	}
}

func TestVncPasswordOnlyForOwner(t *testing.T) {
	fb := &fakeBackend{running: map[int]bool{2: true}}
	h := NewHandler(fb, secret)
	if rec := do(t, h, "GET", "/i/2/vnc-password", instanceToken(secret, 4)); rec.Code != 401 {
		t.Fatalf("other tenant: %d", rec.Code)
	}
	rec := do(t, h, "GET", "/i/2/vnc-password", instanceToken(secret, 2))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "pw123456") {
		t.Fatalf("own: %d %s", rec.Code, rec.Body.String())
	}
}

func TestCDPRelayAllowlist(t *testing.T) {
	var seenPath, seenAuth, seenHost string
	chromium := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath, seenAuth, seenHost = r.URL.Path, r.Header.Get("Authorization"), r.Host
		_, _ = io.WriteString(w, `{"webSocketDebuggerUrl":"ws://127.0.0.1:1/devtools/browser/abc-123"}`)
	}))
	defer chromium.Close()
	port := chromium.Listener.Addr().(*net.TCPAddr).Port
	fb := &fakeBackend{running: map[int]bool{2: true}, cdp: port}
	h := NewHandler(fb, secret)
	tok := instanceToken(secret, 2)

	rec := do(t, h, "GET", "/i/2/cdp/json/version", tok)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "webSocketDebuggerUrl") {
		t.Fatalf("version: %d %s", rec.Code, rec.Body.String())
	}
	if seenPath != "/json/version" || seenAuth != "" || !strings.HasPrefix(seenHost, "127.0.0.1:") {
		t.Fatalf("upstream saw path=%q auth=%q host=%q", seenPath, seenAuth, seenHost)
	}
	// Everything but the version document and the browser websocket is not relayed.
	for _, p := range []string{"/i/2/cdp/json/new", "/i/2/cdp/json/list", "/i/2/cdp/json/close/xyz", "/i/2/cdp/devtools/page/abc", "/i/2/cdp/devtools/inspector.html", "/i/2/cdp/"} {
		if rec := do(t, h, "GET", p, tok); rec.Code != 404 {
			t.Fatalf("%s: %d", p, rec.Code)
		}
	}
	if rec := do(t, h, "GET", "/i/2/cdp/devtools/browser/..%2F..%2Fjson%2Fnew", tok); rec.Code == 200 {
		t.Fatal("path traversal must not be relayed")
	}
	if rec := do(t, h, "GET", "/i/2/cdp/json/version", instanceToken(secret, 3)); rec.Code != 401 {
		t.Fatalf("other tenant: %d", rec.Code)
	}
	fb.running[2] = false
	if rec := do(t, h, "GET", "/i/2/cdp/json/version", tok); rec.Code != 503 {
		t.Fatalf("not running: %d", rec.Code)
	}
}

func TestVNCTunnel(t *testing.T) {
	rfb, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer rfb.Close()
	go func() {
		for {
			c, err := rfb.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_, _ = io.WriteString(c, "RFB 003.008\n")
				buf := make([]byte, 64)
				n, _ := c.Read(buf)
				_, _ = c.Write(append([]byte("echo:"), buf[:n]...))
			}()
		}
	}()
	fb := &fakeBackend{running: map[int]bool{2: true}, vnc: rfb.Addr().(*net.TCPAddr).Port}
	srv := httptest.NewServer(NewHandler(fb, secret))
	defer srv.Close()

	dial := func(token string) (*bufio.Reader, net.Conn, string) {
		c, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
		if err != nil {
			t.Fatal(err)
		}
		req := "GET /i/2/vnc HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: wal-tunnel\r\nAuthorization: Bearer " + token + "\r\n\r\n"
		_, _ = io.WriteString(c, req)
		r := bufio.NewReader(c)
		status, _ := r.ReadString('\n')
		return r, c, status
	}
	if _, c, status := dial(instanceToken(secret, 9)); !strings.Contains(status, "401") {
		t.Fatalf("other tenant: %q", status)
	} else {
		c.Close()
	}
	r, c, status := dial(instanceToken(secret, 2))
	defer c.Close()
	if !strings.Contains(status, "101") {
		t.Fatalf("own token: %q", status)
	}
	for { // skip headers
		line, _ := r.ReadString('\n')
		if line == "\r\n" || line == "" {
			break
		}
	}
	banner, _ := r.ReadString('\n')
	if banner != "RFB 003.008\n" {
		t.Fatalf("banner %q", banner)
	}
	_, _ = io.WriteString(c, "RFB 003.008\n")
	got := make([]byte, 64)
	n, _ := r.Read(got)
	if string(got[:n]) != "echo:RFB 003.008\n" {
		t.Fatalf("echo %q", got[:n])
	}
}

func TestXauthority(t *testing.T) {
	a, err := xauthority(105)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := xauthority(105)
	if string(a) == string(b) {
		t.Fatal("cookies must be random")
	}
	if binary.BigEndian.Uint16(a[0:2]) != 0xFFFF {
		t.Fatal("wildcard family")
	}
	if !strings.Contains(string(a), "MIT-MAGIC-COOKIE-1") || !strings.Contains(string(a), "105") {
		t.Fatalf("entry: %q", a)
	}
}

func TestLayout(t *testing.T) {
	l := Layout{DataDir: "/data", RunDir: "/run/wal", HomeRoot: "/home/chrome", TmpRoot: "/tmp", LegacyUID: 10002}
	if l.UID(1) != 10002 || l.ProfileDir(1) != "/data/profile" || l.DataRoot(1) != "/data/profile" {
		t.Fatal("tenant 1 keeps the single-user layout")
	}
	if l.UID(2) != 10102 || l.ProfileDir(2) != "/data/u2/profile" || l.DataRoot(2) != "/data/u2" {
		t.Fatal("tenant 2 layout")
	}
	seen := map[int]bool{}
	for id := 1; id <= 50; id++ {
		if seen[l.UID(id)] || seen[l.Display(id)+1_000_000] {
			t.Fatal("uids and displays must be unique")
		}
		seen[l.UID(id)] = true
		seen[l.Display(id)+1_000_000] = true
	}
}

func TestManagerLimit(t *testing.T) {
	m := NewManager(Config{MaxInstances: 2})
	for id := 1; id <= 2; id++ {
		if _, err := m.instance(id, true); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := m.instance(3, true); err != errTooMany {
		t.Fatalf("expected limit, got %v", err)
	}
}
