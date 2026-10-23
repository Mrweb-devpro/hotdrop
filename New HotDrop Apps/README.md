# HotDrop rebuilt apps

This isolated rebuild leaves the original apps and the sibling `hotdrop_flutter` directory untouched. The only integration outside this folder is `.github/workflows/hotdrop-rebuild.yml` at the repository root, where GitHub requires workflows.

## Applications

- `apps/web-client`: copied React/Vite yellow-and-cream interface, with reliable HTTP clipboard fallback, two-second `✓ Copied` feedback, keyboard-accessible expand/collapse, transfer errors, and mobile polling support.
- `apps/desktop`: existing Electron shell and Express/Socket.IO host. Auto-start, QR, tray, file sharing, text sharing, layout, and window-close behavior are retained. Electron now waits for the server to listen and uses the same server module as the console host. File paths and peer input are validated. The existing Electron pin is retained.
- `apps/mobile`: new Flutter Android app using Dart's built-in HTTP server, bound to `0.0.0.0`. No Expo, React Native bridge, handwritten HTTP parser, or local Android Studio is required for GitHub builds. The directory previously named `hotdrop_flutter` actually contains a Kotlin/NanoHTTPD project; this rebuild does not import that implementation.

The Android host streams uploads and downloads, bundles the actual web client, polls the feed every two seconds, tracks guest heartbeats, verifies the sharing page at startup, retries startup failures, and refreshes interface addresses. It starts on port 8080, automatically choosing a free port if that port is occupied; the QR/link reflects the actual port. It does not guess a hardcoded hotspot address. If several addresses exist, select the WiFi/hotspot address in the app. Files remain on the host; there is no internet service or account.

## GitHub build

Commit this folder **and** the repository-root workflow. Run **HotDrop rebuilt apps** in GitHub Actions, or push changes to these paths. It produces an Android test APK and a Windows NSIS installer as downloadable artifacts. Nothing has been pushed or run on GitHub from this workspace.

The Android job builds the web UI, generates the standard Flutter Android scaffold, inserts LAN/cleartext permissions, bundles web assets, runs analysis plus server and startup-screen tests, and builds an APK. A separate **Test installed Android APK** job installs that exact release APK on an Android 15 emulator and checks auto-start, bundled JavaScript/CSS, peers, long text, binary upload/download, and resume. Its logs and screenshot are uploaded as `HotDrop-Android-smoke-results`. A physical WiFi/hotspot test is still necessary; emulator forwarding cannot verify a phone manufacturer's network and battery restrictions.

The generated template's release build uses debug signing: this is a testing artifact, not a Play Store production release. It uses a separate Android application ID (`com.hotdrop.hotdrop_mobile`) so it can be tested alongside the old app. Configure a persistent signing key before distributing updates broadly. The Windows installer is unsigned.

Flutter is pinned to **3.47.7** and direct mobile dependencies use exact versions. Android requires API 24 (Android 7) or newer and targets API 36. Per [Android's local network documentation](https://developer.android.com/privacy-and-security/local-network-permission), target API 36 uses the INTERNET permission for LAN access even on Android 17. Before raising the target to 37, implement the new local-network runtime permission flow. The Android JS build uses the committed npm lockfile. GitHub uploads the resolved `pubspec.lock` and generated Gradle configuration as `HotDrop-Android-diagnostics`; commit that lockfile after a successful build to also freeze transitive Flutter dependencies. Local registry DNS is unavailable, so no Flutter lockfile has been fabricated.

## Local development (optional)

From this directory:

```powershell
npm install
npm run build:web
npm test
npm run dev:desktop
```

Use `npm run dev:electron --workspace=apps/desktop` for the desktop window and `npm run build:desktop` for the Windows installer. The old Node 18/pkg packaging route is not used; the Electron installer remains the desktop deliverable.

For a local Flutter 3.47.7 SDK, generate Android in `apps/mobile` with `flutter create --no-pub --platforms=android --org com.hotdrop --project-name hotdrop_mobile .`, then run `node scripts/prepare-mobile.cjs` from this root after building the web UI. Run `flutter pub get`, `flutter analyze lib test`, `flutter test`, and `flutter build apk --release --no-pub` from `apps/mobile`.

## Boundaries and validation

- Maximum 20 files per upload, 1 GB per file, 5,000 characters per text, 200 visible files/texts. Large transfers still require adequate host disk space. Data is temporary and should not be treated as permanent storage.
- Keep the Android app open during hosting. A wake lock keeps the screen awake while the app is visible. There is no foreground service or promise of uninterrupted background hosting. Opening the sharing page in a browser places the host in the background; return to HotDrop if Android pauses it.
- Joining devices must be on a network permitting device-to-device connections. Hotspot isolation, guest WiFi isolation, Windows firewall, and VPN routes can prevent access even when the server started correctly.
- Copy fallback is tested, but a browser can still prohibit clipboard operations; failures show a message rather than falsely showing `Copied`.
- Sharing a URL is offline. Opening an external website requires internet access.
- No accounts or pairing: people with access to the network URL can read and upload shared content. Do not host on an untrusted network.

Local verification (2026-10-23): the full web production build passes, and all five clipboard/Android preparation tests pass. The Android smoke script passes JavaScript syntax checking. The desktop integration test cannot connect to the local server because this execution environment returns EACCES for loopback connections. Flutter/Dart/Android SDK are absent locally, and external downloads fail DNS resolution. The new Flutter tests and emulator job have not run locally. GitHub analysis/tests/builds, the installed-APK smoke test, and real Android-to-browser/desktop transfers are required before calling this release verified.

## Phone test checklist

1. Open the APK on WiFi: confirm `Sharing is ON` and scan its QR from another device.
2. Repeat while the phone hosts a hotspot. Confirm the displayed address belongs to that interface.
3. Upload a binary file and a large video; download them and compare file hashes.
4. Send a long text and URL from each side. Expand/collapse and copy the full content; confirm `✓ Copied` resets after two seconds.
5. Switch networks, rotate/resume the app, disconnect/reconnect guests, and check address/feed recovery.
6. Install the Windows build and confirm auto-start, tray actions, downloads, copy, and dark mode match the original.
