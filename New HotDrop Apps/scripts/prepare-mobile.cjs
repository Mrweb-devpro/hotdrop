const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const mobile = path.join(root, "apps/mobile");
fs.rmSync(path.join(mobile, "test/widget_test.dart"), { force: true });
const web = path.join(root, "apps/web-client/dist");
if (!fs.existsSync(path.join(web, "index.html"))) throw new Error("Build the web client first");
fs.mkdirSync(path.join(mobile, "assets/web/assets"), { recursive: true });
fs.cpSync(web, path.join(mobile, "assets/web"), { recursive: true });
const manifest = path.join(mobile, "android/app/src/main/AndroidManifest.xml");
if (!fs.existsSync(manifest)) throw new Error("Run flutter create --platforms=android --org com.hotdrop --project-name hotdrop_mobile . in apps/mobile first");
let xml = fs.readFileSync(manifest, "utf8");
xml = xml.replace(/<manifest([^>]*)>/, '<manifest$1>\n    <uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />');
xml = xml.replace(/android:label="[^"]*"/, 'android:label="HotDrop"');
if (!xml.includes("android:usesCleartextTraffic")) xml = xml.replace("<application", '<application android:usesCleartextTraffic="true"');
fs.writeFileSync(manifest, xml);
// Use an offline vector drawable for the launcher rather than a default Flutter icon.
const drawables = path.join(mobile, "android/app/src/main/res/drawable");
fs.mkdirSync(drawables, { recursive: true });
fs.writeFileSync(path.join(drawables, "hotdrop_icon.xml"), `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="100" android:viewportHeight="100">
  <path android:fillColor="#FACC15" android:pathData="M0,0h100v100h-100z" />
  <path android:fillColor="@android:color/transparent" android:strokeColor="#18181B" android:strokeWidth="6" android:strokeLineCap="round" android:pathData="M18,40 Q50,10 82,40 M30,46 Q50,27 70,46 M40,52 Q50,42 60,52" />
  <path android:fillColor="#18181B" android:pathData="M28,65h6v8h8v-8h6v23h-6v-9h-8v9h-6z M55,65h10q15,0 15,11.5q0,11.5 -15,11.5h-10z" />
  <path android:fillColor="#FACC15" android:pathData="M61,71h4q9,0 9,5.5q0,5.5 -9,5.5h-4z" />
</vector>`);
xml = xml.replace('android:icon="@mipmap/ic_launcher"', 'android:icon="@drawable/hotdrop_icon"');
fs.writeFileSync(manifest, xml);
console.log("Bundled shared web UI and configured Android LAN permissions.");
