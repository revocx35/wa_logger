package main

import (
	"fmt"
	"path/filepath"
)

// Layout maps a tenant id to the unix user, directories and X display of its browser.
//
// Tenant 1 (the admin, the first account) keeps the layout of the single-user releases so an upgrade finds the
// WhatsApp session where it always was: the profile is /data/profile and it belongs to the old chrome user.
type Layout struct {
	DataDir   string // volume with the profiles
	RunDir    string // tmpfs for per-instance X authority, VNC password
	HomeRoot  string // tmpfs, one HOME per instance
	TmpRoot   string // tmpfs, one TMPDIR per instance
	LegacyUID int
}

const (
	minID      = 1
	maxID      = 9999
	uidBase    = 10100
	displayMin = 100
)

func validID(id int) bool { return id >= minID && id <= maxID }

func (l Layout) UID(id int) int {
	if id == 1 {
		return l.LegacyUID
	}
	return uidBase + id
}

// GID equals the UID: every instance has a group of its own, so group permissions never connect two of them.
func (l Layout) GID(id int) int { return l.UID(id) }

func (l Layout) ProfileDir(id int) string {
	if id == 1 {
		return filepath.Join(l.DataDir, "profile")
	}
	return filepath.Join(l.DataDir, fmt.Sprintf("u%d", id), "profile")
}

// DataRoot is the directory the instance owns on the profile volume (the profile itself for tenant 1).
func (l Layout) DataRoot(id int) string {
	if id == 1 {
		return l.ProfileDir(1)
	}
	return filepath.Join(l.DataDir, fmt.Sprintf("u%d", id))
}

func (l Layout) RunPath(id int) string { return filepath.Join(l.RunDir, fmt.Sprintf("u%d", id)) }
func (l Layout) Home(id int) string    { return filepath.Join(l.HomeRoot, fmt.Sprintf("u%d", id)) }
func (l Layout) Tmp(id int) string     { return filepath.Join(l.TmpRoot, fmt.Sprintf("u%d", id)) }
func (l Layout) Display(id int) int    { return displayMin + id }
