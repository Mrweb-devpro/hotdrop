const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareMobile } = require("../scripts/prepare-mobile.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotdrop-prepare-"));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("hotdrop-prepare-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  function write(file, content) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  write("apps/web-client/dist/index.html", '<script type="module" src="/assets/main.js"></script>');
  write("apps/web-client/dist/assets/main.js", "console.log('HotDrop')");
  write("apps/mobile/test/widget_test.dart", "Generated counter test");
  write("apps/mobile/android/app/src/main/AndroidManifest.xml", `
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET" />
  <application android:label="hotdrop_mobile" android:icon="@mipmap/ic_launcher" android:usesCleartextTraffic="false" />
</manifest>`);
  write("apps/mobile/android/app/build.gradle.kts", `android {
  defaultConfig {
    minSdk = flutter.minSdkVersion
    targetSdk = flutter.targetSdkVersion
  }
}`);
  return { root, write, read: (file) => fs.readFileSync(path.join(root, file), "utf8") };
}

test("Android preparation preserves release LAN access and is repeatable", (t) => {
  const f = fixture(t);
  prepareMobile(f.root);
  f.write("apps/mobile/assets/web/assets/stale.js", "stale");
  prepareMobile(f.root);
  const xml = f.read("apps/mobile/android/app/src/main/AndroidManifest.xml");
  for (const permission of ["INTERNET", "ACCESS_NETWORK_STATE"]) {
    assert.equal(xml.split(`android.permission.${permission}`).length - 1, 1);
  }
  assert.match(xml, /android:usesCleartextTraffic="true"/);
  assert.match(xml, /android:label="HotDrop"/);
  assert.match(xml, /android:icon="@drawable\/hotdrop_icon"/);
  const gradle = f.read("apps/mobile/android/app/build.gradle.kts");
  assert.match(gradle, /minSdk = 24/);
  assert.match(gradle, /targetSdk = 36/);
  assert.equal(f.read("apps/mobile/assets/web/assets/main.js"), "console.log('HotDrop')");
  assert.ok(!fs.existsSync(path.join(f.root, "apps/mobile/assets/web/assets/stale.js")));
  assert.ok(!fs.existsSync(path.join(f.root, "apps/mobile/test/widget_test.dart")));
});

test("Android preparation stops early if the web build is missing", (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.root, "apps/web-client/dist/index.html"));
  assert.throws(() => prepareMobile(f.root), /Build the web client first/);
  assert.match(f.read("apps/mobile/android/app/build.gradle.kts"), /flutter.targetSdkVersion/);
});
