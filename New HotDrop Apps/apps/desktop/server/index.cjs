const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const cors = require("cors");
const multer = require("multer");
const { Server: IOServer } = require("socket.io");

const PORT = Number(process.env.PORT || 8080);
const UPLOAD_DIR = path.join(os.tmpdir(), "hotdrop-uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

function parsePeer(value) {
  try {
    const p = typeof value === "string" ? JSON.parse(value) : value;
    if (!p || typeof p !== "object") throw new Error("Invalid peer");
    return { id: String(p.id || "unknown").slice(0,80), name: String(p.name || "Unknown").slice(0,80), color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : "#FACC15" };
  } catch { return { id: "unknown", name: "Unknown", color: "#FACC15" }; }
}
const peers = new Map();
let files = [];
let texts = [];

function isLink(t) {
  try { const u = new URL(String(t).trim()); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) for (const n of nets[name]||[]) if (n.family==="IPv4" && !n.internal) return n.address;
  return "localhost";
}

const storage = multer.diskStorage({
  destination: (_req,_file,cb)=>cb(null, UPLOAD_DIR),
  filename: (_req,file,cb)=>{ const safe=`${Date.now()}-${Math.random().toString(36).slice(2,8)}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g,"_")}`; cb(null,safe); }
});
const upload = multer({ storage, limits: { fileSize: 1024 ** 3, files: 20 } });

// webDist: when pkg'd, assets are under snapshot; fallback to relative dist next to exe
const candidates = [
  ...(process.resourcesPath ? [path.join(process.resourcesPath, "web-client-dist")] : []),
  path.resolve(__dirname, "..", "..", "web-client", "dist"),
  path.resolve(path.dirname(process.execPath), "web-client-dist"),
  path.resolve(__dirname, "web-client-dist"),
  path.join(__dirname, "..", "web-client-dist"),
];
let webDist = candidates.find(p=>fs.existsSync(p) && fs.existsSync(path.join(p,"index.html"))) || candidates[0];
if (fs.existsSync(webDist)) {
  console.log(`Serving web-client from ${webDist}`);
  app.use(express.static(webDist));
} else {
  console.log(`Web dist not found, checked: ${candidates.join(", ")}`);
}

app.get("/api/info", (_req,res)=>res.json({ ip: getLocalIP(), port: server.address()?.port || PORT, hostName: os.hostname() || "HotDrop Desktop Host" }));
app.get("/api/files", (_req,res)=>res.json({ files: files.map(({path:_p,...r})=>r) }));
app.get("/api/texts", (_req,res)=>res.json({ texts }));
app.post("/api/upload", upload.array("files",20), (req,res)=>{
  const from = parsePeer(req.body.from);
  const uploaded = req.files.map(f=>({ id: Math.random().toString(36).slice(2,10), name: f.originalname, size: f.size, mime: f.mimetype, url: `/api/files/${encodeURIComponent(f.filename)}`, from, at: Date.now(), path: f.path }));
  files = [...uploaded, ...files].slice(0,200);
  uploaded.forEach(m=>{ const {path:_p,...rest}=m; io.emit("file:new", rest); });
  res.json({ files: uploaded.map(({path:_p,...r})=>r) });
});
app.get("/api/files/:filename", (req,res)=>{ if (path.basename(req.params.filename) !== req.params.filename || !/^[a-zA-Z0-9._-]+$/.test(req.params.filename) || !files.some(f => f.url === `/api/files/${encodeURIComponent(req.params.filename)}`)) return res.status(404).send("Not found"); const p=path.join(UPLOAD_DIR, req.params.filename); if(!fs.existsSync(p)) return res.status(404).send("Not found"); const meta = files.find(f => f.url === `/api/files/${encodeURIComponent(req.params.filename)}`); res.download(p, meta.name); });
app.post("/api/text", (req,res)=>{
  const {text,from}=req.body; if(!text||!from) return res.status(400).json({error:"text and from required"});
  const item={ id: Math.random().toString(36).slice(2,10), text: String(text).slice(0,5000), type: isLink(text)?"link":"text", from: parsePeer(from), at: Date.now() };
  texts=[item,...texts].slice(0,200); io.emit("text:new", item); res.json({item});
});
app.use((err, _req, res, _next) => {
  res.status(err instanceof multer.MulterError ? 413 : 400).json({ error: err.message || "Request failed" });
});
app.get("*", (_req,res)=>{
  const idx=path.join(webDist,"index.html");
  if(fs.existsSync(idx)) return res.sendFile(idx);
  res.send("HotDrop Desktop Host running. Build web-client first: npm run build --workspace=apps/web-client . Open http://"+getLocalIP()+":"+PORT);
});

const server = http.createServer(app);
const io = new IOServer(server, { cors:{origin:"*"} });
io.on("connection", (socket)=>{
  socket.on("peer:join", (peer)=>{ peers.set(socket.id, parsePeer(peer)); io.emit("peers", Array.from(peers.values())); });
  socket.on("disconnect", ()=>{ peers.delete(socket.id); io.emit("peers", Array.from(peers.values())); });
});
function start() { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(PORT, "0.0.0.0", ()=>{ server.removeListener("error", reject); resolve(server); }); }); }
module.exports = { start, server, io, getLocalIP, PORT };
if (require.main === module) start().then(()=>{
  const ip=getLocalIP();
  console.log(`\n ================= HotDrop Desktop Host =================`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${ip}:${PORT}  <- SHARE THIS with guests`);
  console.log(`  Uploads: ${UPLOAD_DIR}`);
  console.log(`  Keep this window OPEN while sharing. Close to stop.`);
  console.log(` ========================================================\n`);
  if(!fs.existsSync(path.join(webDist,"index.html"))) console.log("WARN: web-client dist missing - rebuild with npm run build --workspace=apps/web-client");
  // keep console open when double-clicked
  if (process.stdin.isTTY) {
    console.log("Press Ctrl+C to stop server.");
  } else {
    console.log("Server running... (don't close this window)");
  }
  process.stdin.resume();
}).catch((error) => { console.error(error); process.exitCode = 1; });
if (require.main === module) process.on("SIGINT", ()=>{ console.log("\nShutting down..."); io.close(() => process.exit(0)); });

