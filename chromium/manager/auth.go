package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Tokens are derived from the control secret, which only the app container's supervisor and this manager know.
// A tenant worker is handed the token of its own instance and cannot compute anyone else's.

func deriveToken(secret []byte, label string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(label))
	return hex.EncodeToString(mac.Sum(nil))
}

func instanceToken(secret []byte, id int) string {
	return deriveToken(secret, "wal/chromium/instance/"+strconv.Itoa(id))
}

func adminToken(secret []byte) string { return deriveToken(secret, "wal/chromium/admin") }

type authLevel int

const (
	authNone authLevel = iota
	authInstance
	authAdmin
)

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

func tokenEq(a, b string) bool { return hmac.Equal([]byte(a), []byte(b)) }

// authorize returns the strongest level the request's bearer token proves for instance id.
func authorize(secret []byte, r *http.Request, id int) authLevel {
	t := bearer(r)
	if t == "" {
		return authNone
	}
	// Both comparisons always run so timing does not reveal which token was close.
	admin := tokenEq(t, adminToken(secret))
	inst := tokenEq(t, instanceToken(secret, id))
	switch {
	case admin:
		return authAdmin
	case inst:
		return authInstance
	}
	return authNone
}

func denyDelay() { time.Sleep(150 * time.Millisecond) }
