package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strconv"
	"time"
)

// NewHandler is the manager's HTTP API. Every /i/<id>/… route needs the bearer token of that instance (or the admin
// token); nothing else reaches a browser.
func NewHandler(b Backend, secret []byte) http.Handler {
	s := &server{b: b, secret: secret}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]bool{"ok": true}) })
	mux.HandleFunc("POST /i/{id}/ensure", s.guard(authInstance, s.ensure))
	mux.HandleFunc("POST /i/{id}/restart", s.guard(authInstance, s.restart))
	mux.HandleFunc("DELETE /i/{id}", s.guard(authAdmin, s.remove))
	mux.HandleFunc("GET /i/{id}/vnc-password", s.guard(authInstance, s.vncPassword))
	mux.HandleFunc("GET /i/{id}/vnc", s.guard(authInstance, s.vncTunnel))
	mux.HandleFunc("GET /i/{id}/cdp/json/version", s.guard(authInstance, s.cdp))
	mux.HandleFunc("GET /i/{id}/cdp/devtools/browser/{uuid}", s.guard(authInstance, s.cdp))
	return mux
}

type server struct {
	b      Backend
	secret []byte
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// guard parses the instance id and checks the token before the handler runs.
func (s *server) guard(min authLevel, h func(http.ResponseWriter, *http.Request, int)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil || !validID(id) {
			fail(w, 404, "not found")
			return
		}
		if authorize(s.secret, r, id) < min {
			denyDelay()
			fail(w, 401, "unauthorized")
			return
		}
		h(w, r, id)
	}
}

func (s *server) ensure(w http.ResponseWriter, r *http.Request, id int) {
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	if err := s.b.Ensure(ctx, id); err != nil {
		s.backendError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ready": true})
}

func (s *server) restart(w http.ResponseWriter, r *http.Request, id int) {
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	if err := s.b.Restart(ctx, id); err != nil {
		s.backendError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ready": true})
}

func (s *server) remove(w http.ResponseWriter, r *http.Request, id int) {
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	if err := s.b.Delete(ctx, id); err != nil {
		fail(w, 500, "could not remove the browser data")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *server) backendError(w http.ResponseWriter, err error) {
	log.Printf("browser request failed: %v", err)
	switch err {
	case errTooMany:
		fail(w, 503, "too many browser instances")
	case errNotReady:
		fail(w, 503, "browser is not ready yet")
	default:
		fail(w, 500, "browser could not be started")
	}
}

func (s *server) vncPassword(w http.ResponseWriter, r *http.Request, id int) {
	_, _, pw, ok := s.b.Endpoints(id)
	if !ok {
		fail(w, 503, "browser is not running")
		return
	}
	writeJSON(w, 200, map[string]string{"password": pw})
}

var uuidRe = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)

// cdp relays the browser-level DevTools endpoint: GET /json/version and the one WebSocket it points to. Page-level
// endpoints, /json/new, /json/close and the inspector UI are not relayed.
func (s *server) cdp(w http.ResponseWriter, r *http.Request, id int) {
	port, _, _, ok := s.b.Endpoints(id)
	if !ok {
		fail(w, 503, "browser is not running")
		return
	}
	path := "/json/version"
	if u := r.PathValue("uuid"); u != "" {
		if !uuidRe.MatchString(u) {
			fail(w, 404, "not found")
			return
		}
		path = "/devtools/browser/" + u
	}
	target := &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(port))}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = target.Scheme
			pr.Out.URL.Host = target.Host
			pr.Out.URL.Path = path
			pr.Out.URL.RawPath = ""
			pr.Out.URL.RawQuery = ""
			pr.Out.Host = target.Host // Chromium only answers to an IP or localhost Host header
			pr.Out.Header.Del("Authorization")
			pr.Out.Header.Del("Origin")
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) { fail(w, 502, "browser is not reachable") },
	}
	rp.ServeHTTP(w, r)
}

// vncTunnel turns the connection into a raw byte tunnel to x11vnc (Upgrade: wal-tunnel). The tenant's app wraps it
// into a WebSocket for the browser.
func (s *server) vncTunnel(w http.ResponseWriter, r *http.Request, id int) {
	_, vnc, _, ok := s.b.Endpoints(id)
	if !ok {
		fail(w, 503, "browser is not running")
		return
	}
	if r.Header.Get("Upgrade") != "wal-tunnel" {
		fail(w, 400, "expected Upgrade: wal-tunnel")
		return
	}
	up, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(vnc)), 3*time.Second)
	if err != nil {
		fail(w, 502, "VNC server unavailable")
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		up.Close()
		fail(w, 500, "cannot hijack")
		return
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		up.Close()
		return
	}
	_, _ = fmt.Fprint(rw, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: wal-tunnel\r\n\r\n")
	if rw.Flush() != nil {
		conn.Close()
		up.Close()
		return
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(up, rw); done <- struct{}{} }()
	go func() { _, _ = io.Copy(conn, up); done <- struct{}{} }()
	<-done
	conn.Close()
	up.Close()
}
