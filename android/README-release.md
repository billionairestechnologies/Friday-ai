# Releasing the Android app to Google Play

One-time setup, then the same handful of steps for every update after that.

## One-time: create the upload key

Run this yourself, on your own machine (not in a shared/cloud environment) — it's a secret you
need to keep safe forever. If you lose it, you can never publish an update to this same app again
under `com.friday.app`; Google will not reset it for you.

```bash
keytool -genkeypair -v -keystore friday-upload-key.jks -alias friday-upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

It'll ask for a store password, a key password, and your name/org — anything reasonable works.
Store the resulting `.jks` file somewhere safe **outside this repo** (a password manager's file
storage, an encrypted drive, etc.) and back it up. It is gitignored on purpose — never commit it.

Then create `android/app/keystore.properties` (copy `keystore.properties.example` next to it) with
the real path and passwords:

```
storeFile=/absolute/path/to/friday-upload-key.jks
storePassword=<the store password you set>
keyAlias=friday-upload
keyPassword=<the key password you set>
```

`app/build.gradle.kts` already reads this file automatically for release builds — nothing else to
wire up.

## One-time: create the app in Play Console

You're already at this step (the "Create app" screen). Fill in:
- **App name**: Friday
- **Package name**: `com.friday.app` — must match `applicationId` in `android/app/build.gradle.kts`
  exactly, and can never be changed after you create the app.
- **Default language**, **App or game**, **Free or paid** — pick as appropriate, then Create app.

After creation, Play Console walks you through required setup before you can release:
- **Store listing**: icon, screenshots, short/full description, category.
- **Privacy policy URL**: `https://friday.billionairestechnologies.com/privacy` (already live).
- **App content**: content rating questionnaire, target audience/age, data safety form (what
  Friday collects — account info, chat content, etc. — and why).
- **App signing**: accept Play App Signing when prompted (the default, recommended path) — Google
  keeps the real signing key and re-signs what you upload using it; your `keystore.properties` key
  above is only the "upload key" that proves uploads are really from you.

## Every release, first time and updates alike

1. Bump the version in `android/app/build.gradle.kts`:
   ```kotlin
   versionCode = 2          // must strictly increase every single submission, forever
   versionName = "1.1"      // human-readable, shown to users — bump however you like
   ```
2. Build the release bundle:
   ```bash
   cd android
   ./gradlew bundleRelease
   ```
   Output: `android/app/build/outputs/bundle/release/app-release.aab`.
3. In Play Console → your app → **Testing → Internal testing** (recommended for the very first
   release, and a good habit for every release after — lets you and a few testers install it
   before it's public) or **Production**, click **Create new release**, upload that `.aab`, fill in
   the release notes, and roll it out.
4. Google reviews it — a new app's first review is typically the slowest (can take a day or more);
   updates to an already-approved app are usually much faster.

## Later: automating this

Once this manual flow feels solid, it's straightforward to wire `./gradlew bundleRelease` plus the
[Play Developer Publishing API](https://developers.google.com/android-publisher) (via a GitHub
Action like `r0adkll/upload-google-play` or Fastlane's `supply`) into CI, so a tagged commit
uploads a release automatically instead of a manual `./gradlew` + upload each time. Not set up yet
— ask if/when you want it.
