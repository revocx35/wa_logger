// wal-chromium-manager runs one Chromium (with its own virtual display and VNC server) per wa_logger user inside the
// chromium container, each under its own unix user, and exposes them to the app container only through a
// token-checked API. See ARCHITECTURE.md §3 "chromium container".
package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"syscall"
	"time"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v > 0 {
		return v
	}
	return def
}

func main() {
	secret := os.Getenv("CONTROL_SECRET")
	if len(secret) < 8 {
		log.Fatal("CONTROL_SECRET must be set (at least 8 characters)")
	}
	_ = os.Unsetenv("CONTROL_SECRET") // children never see it (their environment is built from scratch anyway)
	listen := os.Getenv("LISTEN_ADDR")
	if listen == "" {
		log.Fatal("LISTEN_ADDR must be set (host:port on the network shared with the app)")
	}
	m := regexp.MustCompile(`^(\d{3,4})x(\d{3,4})x(16|24)$`).FindStringSubmatch(env("SCREEN", "1280x800x24"))
	if m == nil {
		log.Fatal("invalid SCREEN (expected e.g. 1280x800x24)")
	}
	w, _ := strconv.Atoi(m[1])
	h, _ := strconv.Atoi(m[2])

	mgr := NewManager(Config{
		Layout: Layout{
			DataDir:   env("DATA_DIR", "/data"),
			RunDir:    env("RUN_DIR", "/run/wal"),
			HomeRoot:  env("HOME_ROOT", "/home/chrome"),
			TmpRoot:   env("TMP_ROOT", "/tmp"),
			LegacyUID: envInt("LEGACY_UID", 10002),
		},
		Width: w, Height: h,
		MaxInstances: envInt("MAX_INSTANCES", 20),
		ChromiumBin:  env("CHROMIUM_BIN", "chromium"),
		NoSandbox:    os.Getenv("CHROMIUM_NO_SANDBOX") == "1",
		Debug:        os.Getenv("CHROMIUM_DEBUG") == "1",
	})
	handler := NewHandler(mgr, []byte(secret))

	serve := func(addr string, h http.Handler) *http.Server {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			log.Fatalf("listen %s: %v", addr, err)
		}
		srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
		go func() {
			if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
				log.Fatalf("serve %s: %v", addr, err)
			}
		}()
		log.Printf("listening on %s", addr)
		return srv
	}
	servers := []*http.Server{serve(listen, handler)}
	// The container's healthcheck only needs /healthz, on loopback.
	if host, port, err := net.SplitHostPort(listen); err == nil && host != "127.0.0.1" && host != "0.0.0.0" && host != "::" && host != "" {
		health := http.NewServeMux()
		health.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]bool{"ok": true}) })
		servers = append(servers, serve(net.JoinHostPort("127.0.0.1", port), health))
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	log.Print("stopping")
	for _, s := range servers {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s.Shutdown(ctx)
		cancel()
	}
	mgr.Shutdown()
	<-mgr.Stopped()
}
