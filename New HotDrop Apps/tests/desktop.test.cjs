const { test } = require("node:test");
const assert = require("node:assert/strict");
process.env.PORT = "0";
const host = require("../apps/desktop/server/index.cjs");

test("desktop host transfers binary files and text, rejects malformed input", async () => {
  await host.start();
  const base = `http://127.0.0.1:${host.server.address().port}`;
  try {
    let response = await fetch(`${base}/api/info`);
    assert.equal(response.status, 200);
    const peer = { id: "test", name: "David", color: "#FACC15" };
    response = await fetch(`${base}/api/text`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "long text ".repeat(100), from: peer }),
    });
    assert.equal((await response.json()).item.text.length, 1000);
    const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
    const data = new FormData();
    data.append("files", new Blob([binary]), "photo.bin");
    data.append("from", "{invalid");
    response = await fetch(`${base}/api/upload`, { method: "POST", body: data });
    assert.equal(response.status, 200);
    const file = (await response.json()).files[0];
    assert.equal(file.from.name, "Unknown");
    assert.equal(file.path, undefined);
    assert.deepEqual(new Uint8Array(await (await fetch(base + file.url)).arrayBuffer()), binary);
    response = await fetch(`${base}/api/files/nonexistent`);
    assert.equal(response.status, 404);
    response = await fetch(`${base}/api/text`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 400);
  } finally { await new Promise((resolve) => host.io.close(resolve)); }
});
