package com.friday.app.ui

import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/** A Material3 calendar date-picker for editing a YYYY-MM-DD birthday string — shared by the
 *  signup form (auth/AuthSheets.kt) and Settings' profile editor (settings/SettingsScreen.kt),
 *  which both used to be a bare text field asking the user to type a date by hand ("Birthday
 *  (YYYY-MM-DD)") instead of picking one from a calendar. [current] is parsed as the dialog's
 *  initial selection when it's already a valid ISO date; [onPicked] receives the new ISO date
 *  string (java.time.LocalDate.toString() is already YYYY-MM-DD) and [onDismiss] closes the
 *  dialog either way (cancel, confirm, or tapping outside it).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BirthdayPickerDialog(current: String, onPicked: (String) -> Unit, onDismiss: () -> Unit) {
    val initialMillis = runCatching { LocalDate.parse(current).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() }.getOrNull()
    val state = rememberDatePickerState(initialSelectedDateMillis = initialMillis)
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                state.selectedDateMillis?.let { millis ->
                    onPicked(Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate().toString())
                }
                onDismiss()
            }) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    ) {
        DatePicker(state = state)
    }
}
