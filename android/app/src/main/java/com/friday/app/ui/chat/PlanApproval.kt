package com.friday.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayChip
import com.friday.app.ui.theme.FridayHairline
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText

/** Above the composer while the newest message is a Build plan waiting for an answer. Nothing is
 *  built until the user approves; typing in the composer instead asks for a revised plan. */
@Composable
fun PlanApprovalBar(onApprove: () -> Unit, onRequestChanges: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(FridaySurface)
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Text("Ready to build this plan?", color = FridayText, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Text(
            "Nothing is built until you approve. To change it, type what you want different below.",
            color = FridayMuted, fontSize = 12.5.sp, lineHeight = 17.sp, modifier = Modifier.padding(top = 2.dp),
        )
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                Modifier
                    .clip(RoundedCornerShape(50))
                    .border(1.dp, FridayHairline, RoundedCornerShape(50))
                    .clickable(onClick = onRequestChanges)
                    .padding(horizontal = 14.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.Edit, null, tint = FridayText, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text("Request changes", color = FridayText, fontSize = 13.5.sp)
            }
            Row(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(50))
                    .background(FridayText)
                    .clickable(onClick = onApprove)
                    .padding(horizontal = 14.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Icon(Icons.Default.Build, null, tint = FridayBg, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text("Approve & build", color = FridayBg, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/** Under a normal-chat reply to a build request: Build Mode lives in the Build workspace. */
@Composable
fun SuggestBuildCard(onOpen: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(FridaySurface)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(34.dp).clip(RoundedCornerShape(10.dp)).background(FridayChip), contentAlignment = Alignment.Center) {
            Icon(Icons.Default.Build, null, tint = FridayText, modifier = Modifier.size(16.dp))
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text("Want Friday to actually build this?", color = FridayText, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            Text("Build plans it with you first, then codes, runs and previews it.", color = FridayMuted, fontSize = 12.sp, lineHeight = 16.sp)
        }
        Spacer(Modifier.width(8.dp))
        Text(
            "Open in Build",
            color = FridayBg, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.clip(RoundedCornerShape(50)).background(FridayText).clickable(onClick = onOpen).padding(horizontal = 12.dp, vertical = 7.dp),
        )
    }
}

/** Above the composer while the Build agent is paused on a permission prompt. The build waits
 *  server-side, so this works from any device. */
@Composable
fun ApprovalBar(approval: com.friday.app.data.BuildApproval, error: String?, onDecide: (String) -> Unit) {
    val amber = androidx.compose.ui.graphics.Color(0xFFD97706)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
            .clip(RoundedCornerShape(18.dp))
            .border(1.dp, amber.copy(alpha = 0.4f), RoundedCornerShape(18.dp))
            .background(FridaySurface)
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Text("Friday wants to", color = amber, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        Text(approval.title, color = FridayText, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        approval.detail?.let {
            Text(
                it, color = FridayMuted, fontSize = 12.sp, lineHeight = 16.sp, maxLines = 6,
                fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                modifier = Modifier.padding(top = 6.dp).fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(FridayChip).padding(8.dp),
            )
        }
        if (approval.always) Text("Always asks — this reaches outside the sandbox or can't be undone.", color = FridayMuted, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
        error?.let { Text(it, color = com.friday.app.ui.theme.FridayError, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp)) }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlineAction("Deny") { onDecide("deny") }
            if (!approval.always) OutlineAction("Allow all") { onDecide("allow_all") }
            Spacer(Modifier.weight(1f))
            Text(
                "Allow", color = FridayBg, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.clip(RoundedCornerShape(50)).background(FridayText).clickable { onDecide("allow") }.padding(horizontal = 18.dp, vertical = 8.dp),
            )
        }
    }
}

@Composable
private fun OutlineAction(label: String, onClick: () -> Unit) {
    Text(
        label, color = FridayText, fontSize = 13.5.sp,
        modifier = Modifier.clip(RoundedCornerShape(50)).border(1.dp, FridayHairline, RoundedCornerShape(50)).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 8.dp),
    )
}
