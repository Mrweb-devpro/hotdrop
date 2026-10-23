const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const ts = require("typescript");
const source = ts.transpileModule(fs.readFileSync(require.resolve("../apps/web-client/src/clipboard.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

function setup({ secure = false, modern, legacy = true } = {}) {
  const events = [];
  const context = {
    exports: {}, window: { isSecureContext: secure }, navigator: { clipboard: modern },
    document: {
      activeElement: { focus: () => events.push("restore") },
      body: { appendChild: () => events.push("append") },
      createElement: () => ({ style: {}, focus() {}, select() {}, setSelectionRange() {}, remove: () => events.push("remove") }),
      execCommand: () => { events.push("legacy"); return legacy; },
    },
  };
  vm.runInNewContext(source, context);
  return { copy: context.exports.copyText, events };
}
test("LAN HTTP uses legacy copy and cleans up", async () => {
  const { copy, events } = setup();
  await copy("full text");
  assert.deepEqual(events, ["append", "legacy", "remove", "restore"]);
});
test("secure clipboard denial falls back", async () => {
  const { copy, events } = setup({ secure: true, modern: { writeText: async () => { throw Error("denied"); } } });
  await copy("text"); assert.ok(events.includes("legacy"));
});
test("failed copy rejects instead of reporting success", async () => {
  const { copy, events } = setup({ legacy: false });
  await assert.rejects(copy("text"), /blocked copying/);
  assert.ok(events.includes("remove"));
});
