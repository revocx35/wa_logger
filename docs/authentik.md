# wa_logger behind authentik

You can put wa_logger behind [authentik](https://goauthentik.io) forward auth on your reverse proxy (tested with
Nginx Proxy Manager 2.16 and authentik 2026.8): browsers then see authentik's login before wa_logger's own login.
The Android app (from 0.8.0) supports this: it detects authentik, signs in once in the system browser and
keeps working in the background.

## How the Android app does it

- Every request to the server goes through an OkHttp interceptor (`android_client/core/.../core/Authentik.kt`; the same file is used in
  wa_logger, insta_logger, web-ip-phone and RWR).
- When the proxy answers with authentik's sign-in redirect (`/outpost.goauthentik.io/start` or an
  `/application/o/authorize/` redirect back to the outpost), the app shows **Sign in with authentik** instead of
  following it into an HTML page.
- Sign-in: OAuth 2 authorization code with PKCE (S256) and `state`, in a Custom Tab (or the default browser),
  against a **public** authentik client. authentik sends the browser back to `<applicationId>:/authentik`, the
  app exchanges the code for an access token (short-lived) and a refresh token (`offline_access`).
- Both tokens are stored encrypted with a non-exportable AES-256-GCM key in the Android Keystore; app data is
  excluded from backups.
- Each request to that server (and only that server: the token is never sent to another origin) carries
  `Authorization: Bearer <access token>`. The proxy's outpost checks it with authentik's token introspection.
  wa_logger itself uses its session cookie, so it ignores that header.
- The access token is refreshed a minute before it expires, and once more if the proxy still asks for a sign-in
  (revoked early). If authentik refuses the refresh token (expired or revoked), the app forgets the sign-in and
  shows the sign-in screen again.
- The outpost's own session cookie is kept out of the app's cookie jar, so every request is checked with the
  token and revoking the app's tokens in authentik takes effect within minutes.
- Changing or forgetting the server (or signing out) revokes the refresh token at authentik.

## Setup

1. **authentik: a public OAuth2 client for the app.** Applications → Providers → Create → OAuth2/OpenID:
   client type *Public*, client ID `walogger-android` (the app's default; editable under *authentik client ID…*),
   grant types *authorization code* + *refresh token*, redirect URI (regex)
   `^io\.github\.revocx35\.walogger(\.debug)?:/authentik$`, scopes `openid`, `profile`, `offline_access`, a signing key (RS256),
   e.g. access token 10 minutes and refresh token 30 days. Create an application for it and bind the users/groups
   that may use the app.
2. **authentik: a proxy provider for the site.** Proxy provider in *Forward auth (single application)* mode with
   the external host `https://wa.example.com`, *Intercept header auth* on, add it to the embedded outpost, and
   bind the same users/groups to its application.
3. **Let the app's tokens through:** edit the OAuth2 provider from step 1 and add the proxy provider from step 2
   to its *Federated OIDC Providers* (`jwt_federation_providers`). authentik's token introspection only accepts a
   token of provider A for proxy provider B when **A lists B** (not the other way round).
4. **Nginx Proxy Manager:** in the proxy host's *Advanced* tab put a `location /` with `auth_request
   /outpost.goauthentik.io/auth/nginx`, the `/outpost.goauthentik.io` location proxied to authentik and the
   `@goauthentik_proxy_signin` redirect (authentik's NPM example). Because NPM drops its own `location /` when the
   advanced config has one, repeat what NPM puts there (`include conf.d/include/proxy.conf;` and the websocket
   headers).
5. In the app: enter the server address as usual and tap **Sign in with authentik**.

wa_logger's own login, sessions and 2FA stay as they are; authentik is an extra layer in front.
