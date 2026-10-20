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

	serve := func(addr string, h http.Handler) (*http.Server, error) {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, err
		}
		srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
		go func() {
			if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
				log.Printf("serve %s: %v", addr, err)
			}
		}()
		log.Printf("listening on %s", addr)
		return srv, nil
	}
	port := env("MANAGER_PORT", "9223")
	// Loopback answers /healthz only (the container's healthcheck; the app container may not even exist yet).
	health := http.NewServeMux()
	health.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]bool{"ok": true}) })
	servers := []*http.Server{}
	explicit := os.Getenv("LISTEN_ADDR")
	if h, _, err := net.SplitHostPort(explicit); explicit == "" || (err == nil && h != "" && h != "0.0.0.0" && h != "::" && h != "127.0.0.1") {
		if srv, err := serve(net.JoinHostPort("127.0.0.1", port), health); err != nil {
			log.Fatalf("listen: %v", err)
		} else {
			servers = append(servers, srv)
		}
	}
	// The API listens on our address on the network shared with the app, as soon as that network is there.
	apiCh := make(chan *http.Server, 1)
	go func() {
		addr := os.Getenv("LISTEN_ADDR")
		for addr == "" {
			if ip := onLinkAddress(env("BACKEND_PEER", "app")); ip != "" {
				addr = net.JoinHostPort(ip, port)
				break
			}
			time.Sleep(2 * time.Second)
		}
		srv, err := serve(addr, handler)
		if err != nil {
			log.Fatalf("listen %s: %v", addr, err)
		}
		apiCh <- srv
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	log.Print("stopping")
	select {
	case srv := <-apiCh:
		servers = append(servers, srv)
	default:
	}
	for _, s := range servers {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s.Shutdown(ctx)
		cancel()
	}
	mgr.Shutdown()
	<-mgr.Stopped()
}
