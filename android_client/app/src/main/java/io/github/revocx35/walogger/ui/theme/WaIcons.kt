package io.github.revocx35.walogger.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The web UI's inline SVG icons (`web/src/components/Icon.tsx`), same paths, plus a few extras
 * the native client needs. Generated from the web source; tint them with `Icon(tint = …)`.
 */
object WaIcons {
    val chats: ImageVector by lazy { icon("chats", "M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2zm3 5v2h10V9H7zm0 4v2h7v-2H7z") }
    val deleted: ImageVector by lazy { icon("deleted", "M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9zm4 2v9h2v-9h-2zm4 0v9h-0.01H16v-9h-2z") }
    val monitor: ImageVector by lazy { icon("monitor", "M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v9h16V6H4z") }
    val settings: ImageVector by lazy { icon("settings", "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-1.3-8h2.6l.5 2.6 1.6.7 2.2-1.5 1.9 1.9-1.5 2.2.7 1.6 2.6.5v2.6l-2.6.5-.7 1.6 1.5 2.2-1.9 1.9-2.2-1.5-1.6.7-.5 2.6h-2.6l-.5-2.6-1.6-.7-2.2 1.5-1.9-1.9 1.5-2.2-.7-1.6L2 13.3v-2.6l2.6-.5.7-1.6-1.5-2.2 1.9-1.9 2.2 1.5 1.6-.7.5-2.6z") }
    val logout: ImageVector by lazy { icon("logout", "M10 3h9a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-9v-2h9V5h-9V3zm-.6 5.4L11 10H3v4h8l-1.6 1.6L10.8 17l5-5-5-5-1.4 1.4z") }
    val search: ImageVector by lazy { icon("search", "M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z") }
    val back: ImageVector by lazy { icon("back", "M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20v-2z") }
    val download: ImageVector by lazy { icon("download", "M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V3zM4 18h16v2H4v-2z") }
    val file: ImageVector by lazy { icon("file", "M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5L13 3.5z") }
    val pin: ImageVector by lazy { icon("pin", "M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7zm0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z") }
    val pushpin: ImageVector by lazy { icon("pushpin", "M14.5 2.5 21.5 9.5l-1.4 1.4-1.1-1.1-3.5 3.5.4 4.6-1.4 1.4-3.9-3.9-5.2 5.2-1.4-1.4 5.2-5.2-3.9-3.9 1.4-1.4 4.6.4 3.5-3.5-1.1-1.1 1.4-1.4z") }
    val user: ImageVector by lazy { icon("user", "M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.4 0-8 2.2-8 5v3h16v-3c0-2.8-3.6-5-8-5z") }
    val group: ImageVector by lazy { icon("group", "M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 13c-3.3 0-6 1.8-6 4v3h12v-3c0-2.2-2.7-4-6-4zm8 0c-.6 0-1.1.1-1.7.2 1.1.9 1.7 2.1 1.7 3.8v3h6v-3c0-2.2-2.7-4-6-4z") }
    val phone: ImageVector by lazy { icon("phone", "M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z") }
    val video: ImageVector by lazy { icon("video", "M3 6h12a1 1 0 0 1 1 1v3.5l5-3.5v10l-5-3.5V17a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z") }
    val check: ImageVector by lazy { icon("check", "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z") }
    val checks: ImageVector by lazy { icon("checks", "M1.4 13.4 7 19l1.4-1.4L2.8 12zM22.6 5.6 12 16.2 7.8 12l-1.4 1.4L12 19 24 7zM18 7l-1.4-1.4-6.3 6.3 1.4 1.4z") }
    val clock: ImageVector by lazy { icon("clock", "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm1 3v5.4l3.6 2.1-1 1.7L11 13.6V7h2z") }
    val refresh: ImageVector by lazy { icon("refresh", "M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h8V3l-3.3 3.3z") }
    val eye: ImageVector by lazy { icon("eye", "M12 5c5 0 9 4.5 10 7-1 2.5-5 7-10 7S3 14.5 2 12c1-2.5 5-7 10-7zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z") }
    val lock: ImageVector by lazy { icon("lock", "M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1h1zm2 0h6V7a3 3 0 0 0-6 0v3z") }
    val archive: ImageVector by lazy { icon("archive", "M3 3h18v5H3V3zm1 6h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9zm5 3v2h6v-2H9z") }
    val forward: ImageVector by lazy { icon("forward", "M14 5l7 7-7 7v-4.1C9 14.9 5.5 16.5 3 20c1-5 4-10 11-11V5z") }
    val edit: ImageVector by lazy { icon("edit", "M3 17.2V21h3.8l11-11-3.8-3.8-11 11zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8L20.7 7z") }
    val close: ImageVector by lazy { icon("close", "M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z") }
    val image: ImageVector by lazy { icon("image", "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v10.6l4-4 3 3 4-4 3 3V6H5zm4 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z") }
    val mic: ImageVector by lazy { icon("mic", "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 6-6.9h-2z") }
    val warning: ImageVector by lazy { icon("warning", "M12 2 1 21h22L12 2zm-1 7h2v6h-2V9zm0 8h2v2h-2v-2z") }
    val ban: ImageVector by lazy { icon("ban", "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-6.3 5.1A8 8 0 0 0 16.9 18.3L5.7 7.1zm1.4-1.4 11.2 11.2A8 8 0 0 0 7.1 5.7z") }
    val poll: ImageVector by lazy { icon("poll", "M4 4h2v16H4V4zm5 6h2v10H9V10zm5-4h2v14h-2V6zm5 8h2v6h-2v-6z") }
    val menu: ImageVector by lazy { icon("menu", "M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z") }
    val shield: ImageVector by lazy { icon("shield", "M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3zm-1 13.6-3.6-3.6L8.8 10.6l2.2 2.2 4.2-4.2 1.4 1.4-5.6 5.6z") }
    val play: ImageVector by lazy { icon("play", "M8 5v14l11-7z") }
    val pause: ImageVector by lazy { icon("pause", "M6 19h4V5H6v14zm8-14v14h4V5h-4z") }
    val keyboard: ImageVector by lazy { icon("keyboard", "M20 5H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z") }
    val more: ImageVector by lazy { icon("more", "M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z") }
    val openNew: ImageVector by lazy { icon("openNew", "M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z") }
    val server: ImageVector by lazy { icon("server", "M20 13H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-6c0-.55-.45-1-1-1zM7 19c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM20 3H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1zM7 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z") }
    val copy: ImageVector by lazy { icon("copy", "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z") }
    val chevronDown: ImageVector by lazy { icon("chevronDown", "M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z") }
    val backspace: ImageVector by lazy { icon("backspace", "M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3 12.59L17.59 17 14 13.41 10.41 17 9 15.59 12.59 12 9 8.41 10.41 7 14 10.59 17.59 7 19 8.41 15.41 12 19 15.59z") }
    val enter: ImageVector by lazy { icon("enter", "M19 7v4H5.83l3.58-3.59L8 6l-6 6 6 6 1.41-1.41L5.83 13H21V7z") }
    val zoomIn: ImageVector by lazy { icon("zoomIn", "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zm.5-7H9v2H7v1h2v2h1v-2h2V9h-2z") }

    private fun icon(name: String, d: String): ImageVector =
        ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
            .addPath(pathData = addPathNodes(d), fill = SolidColor(Color.Black))
            .build()
}
