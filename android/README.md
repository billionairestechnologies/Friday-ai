# Friday for Android

Native **Kotlin + Jetpack Compose + Material 3** app. Guest-first AI chat with Search / Think / Canvas, swipe drawer, auth sheet, mock streaming, dark code blocks, and a Canvas workspace.

Package: `com.friday.app`  
Min SDK 26 · Target / compile 35

## Open & run

1. Install [Android Studio](https://developer.android.com/studio) (Koala / Ladybug or newer, JDK 17).
2. **File → Open** this `FridayAndroid` folder.
3. Let Gradle sync (first sync downloads the SDK + Compose BOM).
4. Pick an emulator (Pixel 6, API 34+) or a USB device with USB debugging.
5. Click **Run**.

Command line (SDK + JDK 17 on `PATH`):

```bash
./gradlew assembleDebug
```

Debug APK:

```
app/build/outputs/apk/debug/app-debug.apk
```

Install on a device:

```bash
./gradlew installDebug
```

Release APK (unsigned until you add a keystore):

```bash
./gradlew assembleRelease
```

Then **Build → Generate Signed Bundle / APK** in Android Studio to sign for Play / sideload.

## What you get

- Cold start = guest home, glow, **What’s on your mind?**, composer **docked at the bottom** (no login wall)
- First-open entrance animation (skipped if animator scale is 0)
- Composer: Attach · Search (blue) · Think (purple) · Canvas (orange) · Auto · Mic / Send / Stop
- All three modes can be on together; placeholder swaps (Canvas > Think > Search)
- ☰ and **left-edge swipe** open the same drawer
- Log in slides up as a bottom sheet (mock — tap Continue)
- Send streams tokens. Think shows “Consulting my inner monologue…”. Search lists sources. Canvas shimmers then fills
- Dark code blocks (`#151515`) with Copy
- Recents include a seeded CSS + Python showcase thread

Chat is **offline mock** (`ChatRepository`). `ApiClient` is the interface to swap in `https://friday.billionairestechnologies.com` later.

## Layout

```
app/src/main/java/com/friday/app/
  MainActivity.kt
  FridayApp.kt                 # drawer + chat shell
  data/
    Models.kt                  # Mode, ChatEvent, ChatServing
    Seed.kt
    ChatRepository.kt          # delayed Flow stream
  ui/
    FridayViewModel.kt
    theme/                     # color tokens, type, shapes
    composer/ComposerBar.kt
    chat/ChatThread.kt + CodeBlock.kt
    canvas/CanvasPanel.kt
    auth/AuthSheets.kt
    shell/DrawerPane.kt + Sheets.kt
```

## Notes

- Vector icons only (Material Icons Extended).
- Haptics on send and mode toggle (`VIBRATE` permission).
- Do not put API keys in this project. Keep keys on a server when you wire `ApiClient`.
