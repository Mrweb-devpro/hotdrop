// Run against a GitHub Actions emulator after building the actual release APK.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const app = "com.hotdrop.hotdrop_mobile";
const base = "http://127.0.0.1:18080";
const logs = path.resolve("android-smoke-results");
fs.mkdirSync(logs, { recursive: true });

function adb(...args) {
  return execFileSync("adb", args, { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
}
async function request(route, options = {}) {
  const response = await fetch(base + route, { ...options, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, `${route} returned HTTP ${response.status}`);
  return response;
}
async function ready() {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { return await (await request("/api/info")).json(); }
    catch (error) { lastError = error; await delay(1000); }
  }
  throw new Error(`Android host did not auto-start: ${lastError}`);
}
async function main() {
  assert.equal(adb("shell", "getprop", "ro.kernel.qemu").trim(), "1", "Use an emulator for this test");
  const apk = path.resolve(process.argv[2] || "apps/mobile/build/app/outputs/flutter-apk/app-release.apk");
  assert.ok(fs.existsSync(apk), `APK missing: ${apk}`);
  adb("install", "-r", apk);
  adb("logcat", "-c");
  adb("forward", "tcp:18080", "tcp:8080");
  adb("shell", "am", "start", "-W", "-n", `${app}/.MainActivity`);
  const info = await ready();
  assert.equal(info.realtime, "polling");
  assert.equal(info.port, 8080);
  const html = await (await request("/")).text();
  assert.match(html, /<div id="root"/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((match) => match[1]);
  assert.ok(assets.some((asset) => asset.endsWith(".js")), "Bundled JavaScript is missing");
  for (const asset of assets) {
    const response = await request(asset);
    assert.ok((await response.arrayBuffer()).byteLength > 0, `Empty asset: ${asset}`);
  }
  const peer = { id: "android-smoke", name: "Build test", color: "#FACC15" };
  await (await request("/api/peer", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(peer),
  })).arrayBuffer();
  const text = "Long text from Android smoke test. ".repeat(40);
  const sent = await (await request("/api/text", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, from: peer }),
  })).json();
  assert.equal(sent.item.text, text);
  const feed = await (await request("/api/texts")).json();
  assert.equal(feed.texts[0].text, text);
  const binary = Uint8Array.from({ length: 65536 }, (_, i) => i % 256);
  const form = new FormData();
  form.append("files", new Blob([binary]), "Phone Photo.bin");
  form.append("from", JSON.stringify(peer));
  const upload = await (await request("/api/upload", { method: "POST", body: form })).json();
  assert.equal(upload.files[0].name, "Phone Photo.bin");
  assert.equal(upload.files[0].from.id, peer.id);
  const downloaded = new Uint8Array(await (await request(upload.files[0].url)).arrayBuffer());
  assert.deepEqual(downloaded, binary);
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  adb("shell", "am", "start", "-W", "-n", `${app}/.MainActivity`);
  await ready();
  console.log("Release APK passed: auto-start, bundled web UI, peer, text, binary upload/download, resume.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  try { fs.writeFileSync(path.join(logs, "logcat.txt"), adb("logcat", "-d", "-t", "3000")); } catch (_) {}
  try {
    adb("shell", "screencap", "-p", "/sdcard/hotdrop-smoke.png");
    adb("pull", "/sdcard/hotdrop-smoke.png", path.join(logs, "screen.png"));
  } catch (_) {}
  try { adb("forward", "--remove", "tcp:18080"); } catch (_) {}
});
