# Security

wa_logger stores private conversations. This document explains what it protects against, what it doesn't,
and how to run it safely. The design details are in [ARCHITECTURE.md](ARCHITECTURE.md) §6.

## Threat model

**Protected against**

| Threat | Mitigation |
|---|---|
| Someone on the network finds the login page | Single owner. Signup needs the one-time `SETUP_TOKEN` and closes after the first account. scrypt (N=2¹⁷) passwords. Race-free throttling: each attempt is charged before hashing. Per-IP exponential lockout means one attacker can't lock you out, and a global per-account cap bounds distributed guessing. Atomic single-use TOTP codes, optional 2FA, audit log. |
| Theft of the database, media files or backups | Envelope encryption (see below). Without the password or recovery key, stored content is unreadable. |
| Stolen database *and* the server's `.env` | `.env` holds no data keys, so this is still unreadable. |
| Malicious message content (HTML, SVG, scripts, crafted file names, links) | Never rendered as HTML (React text nodes only), strict CSP, only `http(s)` links (`rel=noopener noreferrer nofollow`). Media served with `Content-Security-Policy: sandbox`, `nosniff`, and as a download unless it is a raster image, audio or video. |
| CSRF / clickjacking / cross-site WebSocket hijacking | `SameSite=Strict` `__Host-` cookie, exact `Origin` check on every state-changing request and WebSocket, session-bound CSRF token, `frame-ancestors 'none'`. |
| A stolen session cookie | Enough to read logs until it expires, but not enough to add 2FA (needs the password) or to wipe data or rotate the recovery key (needs the password + 2FA code). |
| Crafted messages meant to freeze the server or UI (ReDoS) | Text and vCard parsers are linear-time with size caps. Tests include pathological inputs. |
| Lateral movement between containers | The app has no internet. Only Chromium talks to WhatsApp. CDP and VNC listen only on an internal network shared with the app. Only Caddy publishes ports. Non-root, read-only root filesystems, `cap_drop: ALL`, `no-new-privileges`, memory and pid limits. |
| A compromised web page inside Chromium | Chromium sandbox **enabled** (seccomp profile instead of `--no-sandbox`). A managed policy blocks navigation to anything but WhatsApp, and blocks downloads, file pickers and extensions. |
| Log leakage | Logs never contain message content, names, cookies or tokens. URLs are logged without query strings, and phone numbers are masked. |

**Not protected against** (out of scope, or inherent)

- A **fully compromised host or root on the host**. It can read process memory (the current data key and plaintext
  as it is captured), the Chromium profile, and everything a logged-in session decrypts.
- **The WhatsApp session in `chromium_profile`.** Whoever has this volume can use your WhatsApp account. Protect it.
- **Metadata**: WhatsApp IDs (which contain phone numbers), timestamps, message types, flags (deleted, edited, from-me)
  and media sizes are stored unencrypted, so lists can be sorted and paginated without the key.
- A stolen, still-valid **session cookie** gives access until it expires (idle 8 h, absolute 7 days by default) or is revoked.
- WhatsApp's Terms of Service: this is an unofficial client.
- **Kernel attack surface from user namespaces.** Keeping Chromium's sandbox on means the chromium container's
  seccomp profile must allow `clone`/`unshare` with namespace flags. That is the trade-off for not using `--no-sandbox`.
- The Chromium URL policy restricts **navigation** only. Scripts running inside WhatsApp Web can still fetch other
  URLs, and anything that controls CDP (the app) could too. The app refuses every request coming from Chromium.

## Encryption at rest

```
password ──scrypt──► master ─HKDF─► authHash (stored)       recovery key ─HKDF─► recovery KEK
                              └HKDF─► KEK ──AES-GCM──► owner X25519 private key ◄──AES-GCM── recovery KEK
                                                         ▲
                                     session secret (cookie only) ──HKDF──► session copy of the private key
owner X25519 public key ──ECIES──► wrapped DEK (rotated at start + every 24 h)
DEK ──AES-256-GCM (AAD = table|column|row)──► message text, captions, names, thumbnails, edit history, reactions
DEK ──chunked AES-256-GCM (64 KiB chunks, index + final flag in AAD)──► media files
```

- The logger only needs the **public key** to write, so it logs while you are logged out, but it cannot read
  anything written under earlier data keys.
- The database stores `sha256(sid‖secret)` for sessions. A database dump cannot be turned into a working cookie or unlock the private key.
- A password change re-wraps the private key. Recovery sets a new password, rotates the recovery key, disables 2FA
  and revokes all sessions.
- If you lose **both** the password and the recovery key, the data is gone. Nobody can recover it.

## Running it safely

1. Keep `.env` private (`chmod 600`, which `setup.sh` sets) and don't commit it (`.gitignore` covers it).
2. Prefer LAN/VPN-only access. If you must expose it, use a real domain with Let's Encrypt and enable **2FA**.
3. Store the recovery key offline (password manager or paper).
4. Encrypt the host disk (LUKS / encrypted ZFS dataset). It protects the metadata and the WhatsApp session.
5. Update regularly: `git pull && docker compose up -d --build`. WhatsApp Web changes often.
6. Review **Settings → Security log** and **Sessions** now and then.
7. Back up `app_data` (encrypted). Treat `chromium_profile` backups like a password.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (Security → Advisories), or contact the
repository owner directly. Please don't file public issues for vulnerabilities.
