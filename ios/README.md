# Friday iOS

Native SwiftUI port of the Android app (`../android`), hitting the same
backend (`https://friday.billionairestechnologies.com/api/`) and Supabase
Realtime channel. Built to match the Android/web experience 1:1 — same
screens, colors, copy, and behavior.

## Requirements

- Xcode 15+
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`) — the `.xcodeproj` is generated, not checked in.

## Setup

```sh
cd ios
xcodegen generate
open FridayApp.xcodeproj
```

Build/run the `FridayApp` scheme on a simulator or device.

## Structure

Mirrors the Android app's package layout:

- `FridayApp/Sources/Data/API` — REST clients (Auth, Chat, Conversations, Models, Usage, Billing, Sandbox, Voice, App version), `TokenStore` (Keychain-backed session storage), `ApiClient` (bearer auth + single auto-refresh-and-retry on 401).
- `FridayApp/Sources/Data/Realtime` — hand-rolled Supabase Realtime client (Phoenix Channels over `URLSessionWebSocketTask`), matching Android's approach instead of adding the full Supabase SDK.
- `FridayApp/Sources/Data/Models.swift` — shared data model (ported field-for-field from Android's `Models.kt`).
- `FridayApp/Sources/App` — `FridayViewModel` (the app's single state holder / chat orchestration, including per-conversation cancellable streaming tasks) and `RootShell` (navigation).
- `FridayApp/Sources/UI/*` — screen-by-screen SwiftUI views: Auth (landing + email/OTP form), Chat (thread, thought trail, code blocks), Composer (text input, mode chips, voice recording), Canvas (artifact detection + preview/run), Settings, Plans/billing, Shell (drawer, top bar, model branding), Voice (full-screen voice mode + particle sphere visualization), Theme (design tokens ported from Android's `Color.kt`).

## Auth callback

OAuth (Google/GitHub) redirects to `com.friday.app.ios://auth-callback#friday_session=<base64url json>`,
registered as a custom URL scheme in `project.yml`. **This scheme must be
unique to this app** — reusing a scheme already claimed by another
installed app silently breaks the OAuth redirect (this exact bug hit the
Android app with a colliding `fridayai://` scheme from an older project).
If the backend's `mobile-auth-bridge` needs to know about this scheme
explicitly, register it there before shipping.

## Known gaps vs. Android (follow-up work)

- Voice Mode's real-time FFT frequency bands are approximated from the mic
  level meter rather than a true `AVAudioEngine` tap + FFT — swap in a real
  tap for the particle sphere's per-band shimmer.
- Razorpay checkout is stubbed to the order-creation + poll-for-paid flow;
  wire in the `RazorpayCheckout` pod for the actual payment sheet.
- No offline/demo mode (Android's disconnected mock `ChatRepository`) —
  matches Android's actual guest behavior (no session ⇒ routes to auth), so
  this is intentional, not a gap.
