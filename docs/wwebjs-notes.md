# whatsapp-web.js integration notes (v1.34.7)

These are facts about the library that the design relies on, checked against
`server/node_modules/whatsapp-web.js/src`. Re-check them whenever you upgrade the library.

## Connecting to the remote Chromium
- `Client.initialize()` (Client.js ~L445): when `puppeteer.browserURL`/`browserWSEndpoint` is set, it calls
  `puppeteer.connect()` and **opens a new tab** (`browser.newPage()`). Without them it would launch a browser.
  So `wa/browser.ts#cleanupTabs` closes leftover WhatsApp tabs first (two WA tabs fight over the session) and
  keeps one tab open so Chromium doesn't exit. `focusWaTab` closes the rest and brings the WA tab to the
  front so VNC shows it.
- Chrome rejects CDP HTTP requests whose `Host` is not an IP or `localhost`, so we resolve `chromium` to an IP.
  Headful Chromium ignores `--remote-debugging-address`, so a socat relay exposes 9222 as 9223.
- `userAgent`: the default is an old Chrome 101 string. We pass `false` to keep Chromium's real UA.
- `webVersionCache: {type:'none'}` (WebCacheFactory.js): the default `local` cache writes `.wwebjs_cache` to
  the CWD, which fails on our read-only root filesystem.
- `authStrategy: NoAuth`. The session lives in Chromium's own profile (`/data/profile` volume).
  `LocalAuth` would need `userDataDir`, which a connected browser ignores.
- `takeoverOnConflict: true` makes the client call `Socket.takeover()` when WhatsApp reports CONFLICT.

## Broken helpers on current WhatsApp Web (found in production, Sept 2026)
- `getChats()`, `getChatById()` and `getProfilePicUrl()` all go through `WWebJS.getChatModel`, which looks up the
  chat's `lastReceivedKey` and refreshes group metadata. On WhatsApp Web 2.3000.10483x this throws
  `DataError: Failed to execute 'get' on 'IDBObjectStore': No key or key range specified` for ~90% of chats.
  `getChats()` uses `Promise.all`, so a single failure loses the whole list, and history import failed completely.
- wa_logger therefore reads chats, contacts, history and avatars directly from WhatsApp Web's models
  (`wa/pageapi.ts`), isolating errors per chat. Message serialization (`WWebJS.getMessageModel`) and the event
  hooks still work and are still used.
- Message keys (`msg.id`) no longer carry `_serialized`. The key string is rebuilt as
  `<fromMe>_<remote>_<id>[_<participant>][_<self>]` (own messages end in `_out`); this matched WhatsApp's own
  `MsgKey.toString()` for 3570/3570 loaded messages. Without it, messages were stored under the bare stanza id and
  media downloads, quotes and reactions could not be matched (`mapper.ts#msgKey`).
- One-to-one chats and group participants now use **LID** ids (`…@lid`) instead of phone-number ids (`…@c.us`).
  The phone number comes from `contact.phoneNumber` or `WAWebLidMigrationUtils.toPn()` and is stored encrypted as a
  name fallback.

## Dangerous defaults
- `destroy()` calls `browser.close()`, which **kills the remote Chromium**. The library calls `this.destroy()` itself
  on non-accepted state changes (Client.js ~L850). `wa/client.ts` therefore subclasses `Client` and overrides
  `destroy()` to only `disconnect()`.
- `logout()` also closes the browser. We call `WAWebSocketModel.Socket.logout()` in the page instead.

## Events we use
| Event | Notes |
|---|---|
| `message_create(msg)` | Fires for incoming **and** outgoing new messages (`Msg.on('add')` with `isNewMsg`). **Not** for `gp2` group notifications. |
| `group_join/leave/update/admin_changed/membership_request(notification)` | `gp2` messages are routed here instead. Stored as `system` messages. |
| `message_ciphertext(msg)` | Placeholder "waiting for this message". When it decrypts, the library emits `message_create` for the real message. |
| `message_edit(msg, newBody, prevBody)` | From `Msg.on('change:body change:caption')`. It also fires for thumbnail/body updates on media, so ignore base64-looking bodies. Real edits carry `latestEditMsgKey`. |
| `message_revoke_everyone(after, before?)` | `after` has `type:'revoked'` and the same id. `before` is only set if the original was the most recently changed message (the library's `last_message` trick), so it is **often undefined**. That is why we log every message on arrival. |
| `message_revoke_me(msg)` | Deleted only on the owner's devices. |
| `message_reaction(reaction)` | `reaction.reaction === ''` means removed. `msgId` is the parent message key. |
| `message_ack(msg, ack)` | Ack ticks for own messages. |
| `chat_removed`, `chat_archived(chat, curr, prev)` | |
| `qr`, `loading_screen`, `authenticated`, `ready`, `auth_failure`, `disconnected(reason)` | `disconnected('LOGOUT')` comes from the `post_logout` navigation, after which the library re-injects and emits `qr` again. |

## Message data
- `message._data` (typed as `rawData` in `index.d.ts`) is WhatsApp Web's serialized model. `wa/mapper.ts` reads it defensively.
- `id._serialized` = `<fromMe>_<remote>_<id>[_<participant>]`. `t` is in **seconds**.
- For media messages, `_data.body` is a base64 **JPEG thumbnail**, not text. The caption is `_data.caption`.
  `hasMedia` = `Boolean(directPath)`.
- View-once: `_data.isViewOnce === true`.
- Edits: `latestEditMsgKey`, `latestEditSenderTimestampMs`. Revokes: `type:'revoked'`, `subtype:'sender'|'admin'`.
- `chat.fetchMessages({limit})` calls `loadEarlierMsgs` until it reaches `limit`, and **filters out notifications**.

## Media download
- `Message.downloadMedia()` resolves media in the page, then sends the whole file back as **one base64 string**
  over CDP. That is too much memory for large videos. `wa/media.ts#downloadMessageMedia` uses the same internals
  (`msg.downloadMedia({downloadEvenIfExpensive:true})` → `WAWebDownloadManager.downloadAndMaybeDecrypt`), keeps
  the bytes in a page-side `Map`, and pulls 2 MiB slices that are encrypted straight to disk.
- `mediaStage === 'REUPLOADING'` means expired media is being re-requested from the phone, so retry later.
  A 404 or 410 means it is gone.

## Avatars
- `client.getProfilePicUrl(id)` returns a signed `pps.whatsapp.net` URL. The app container has no internet, so we
  fetch it inside the page, falling back to CDP `Network.loadNetworkResource`, which is not subject to CORS.
