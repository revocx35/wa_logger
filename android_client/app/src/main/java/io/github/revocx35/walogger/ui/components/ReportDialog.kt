package io.github.revocx35.walogger.ui.components

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaType

/** Shows a local crash / not-responding report with a Copy button (nothing is sent anywhere). */
@Composable
fun ReportDialog(title: String, intro: String, report: String?, onClose: () -> Unit, onClear: (() -> Unit)? = null) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    WaDialog(title, onClose) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            MutedText(intro, style = WaType.small)
            if (report == null) {
                Text("No reports.", style = WaType.base, color = Wa.colors.text)
            } else {
                Box(Modifier.fillMaxWidth().heightIn(max = 360.dp).clip(RoundedCornerShape(8.dp)).background(Wa.colors.panel2).verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(10.dp)) {
                    SelectionContainer { Text(report, style = WaType.mono.copy(fontSize = 10.sp, lineHeight = 13.sp), color = Wa.colors.text) }
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (report != null) {
                    WaButton(if (copied) "Copied" else "Copy report", {
                        context.getSystemService(android.content.ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("wa_logger report", report))
                        copied = true
                    }, style = BtnStyle.Primary)
                }
                if (report != null && onClear != null) WaButton("Delete reports", onClear, style = BtnStyle.Ghost)
                WaButton("Close", onClose, style = BtnStyle.Ghost)
            }
        }
    }
}
