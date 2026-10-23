import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { QRCodeSVG } from "qrcode.react";
import { copyText } from "./clipboard";

function CopyButton({ text, className, label = "Copy" }: { text: string; className: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return <span><button className={className} onClick={async () => {
    try {
      await copyText(text);
      setError("");
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch (e) { setError(e instanceof Error ? e.message : "Copy failed. Please select and copy the text."); }
  }}>{copied ? "✓ Copied" : label}</button><span role="status" className="text-xs text-red-600 ml-2">{error}</span></span>;
}

type Peer = { id: string; name: string; color: string };
type FileMeta = { id: string; name: string; size: number; mime: string; url: string; from: Peer; at: number };
type TextItem = { id: string; text: string; type: "link" | "text"; from: Peer; at: number };

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function isLink(t: string) {
  try {
    const u = new URL(t.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function Truncated({ text, max, isLink: isL }: { text: string; max: number; isLink?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const needs = text.length > max;
  const display = needs && !expanded ? text.slice(0, max) + "..." : text;
  const base = "break-all whitespace-pre-wrap overflow-hidden [overflow-wrap:anywhere] block max-w-full cursor-pointer select-text";
  if (isL) {
    return (
      <span role={needs ? "button" : undefined} tabIndex={needs ? 0 : undefined} aria-expanded={needs ? expanded : undefined} onKeyDown={(e) => { if (needs && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setExpanded(!expanded); } }} onClick={() => needs && setExpanded(!expanded)} title={needs ? (expanded ? "Click to collapse" : "Click to expand") : undefined} className={`${base} text-sm font-medium text-blue-600 dark:text-blue-400 underline`}>
        {display}
        {needs && <span className="text-zinc-400 no-underline ml-1 text-xs">{expanded ? " ▲ collapse" : ""}</span>}
      </span>
    );
  }
  return (
    <span role={needs ? "button" : undefined} tabIndex={needs ? 0 : undefined} aria-expanded={needs ? expanded : undefined} onKeyDown={(e) => { if (needs && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setExpanded(!expanded); } }} onClick={() => needs && setExpanded(!expanded)} title={needs ? (expanded ? "Click to collapse" : "Click to expand") : undefined} className={`${base} text-sm bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-3`}>
      {display}
      {needs && <span className="text-zinc-400 ml-1 text-xs">{expanded ? " ▲ collapse" : ""}</span>}
    </span>
  );
}

export default function App() {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [texts, setTexts] = useState<TextItem[]>([]);
  const [me] = useState<Peer>(() => ({
    id: Math.random().toString(36).slice(2, 8),
    name: "Guest-" + Math.floor(Math.random() * 900 + 100),
    color: ["#FACC15", "#FB923C", "#A3E635", "#38BDF8", "#C084FC"][Math.floor(Math.random() * 5)],
  }));
  const [textDraft, setTextDraft] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const [hostInfo, setHostInfo] = useState<{ ip: string; port: number; hostName: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    const saved = localStorage.getItem("hotdrop-theme") as "light" | "dark" | "system" | null;
    return saved || "system";
  });

  // apply theme to <html>
  useEffect(() => {
    const root = document.documentElement;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (t: "light" | "dark" | "system") => {
      const resolved = t === "system" ? (mql.matches ? "dark" : "light") : t;
      root.classList.toggle("dark", resolved === "dark");
    };
    apply(theme);
    localStorage.setItem("hotdrop-theme", theme);
    if (theme === "system") {
      const handler = () => apply("system");
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
  }, [theme]);

  const allItems = useMemo(() => {
    const combined = [
      ...files.map((f) => ({ at: f.at, kind: "file" as const, data: f })),
      ...texts.map((t) => ({ at: t.at, kind: "text" as const, data: t })),
    ];
    return combined.sort((a, b) => b.at - a.at);
  }, [files, texts]);

  useEffect(() => {
    const infoTimer = setInterval(() => {
      fetch("/api/info").then((r) => r.ok ? r.json() : Promise.reject()).then(setHostInfo).catch(() => {});
    }, 3000);
    fetch("/api/info")
      .then((r) => r.json())
      .then(setHostInfo)
      .catch(() => setHostInfo({ ip: location.hostname, port: Number(location.port) || 8080, hostName: "HotDrop Host" }));

    fetch("/api/files")
      .then((r) => r.json())
      .then((d) => setFiles(d.files || []))
      .catch(() => {});
    fetch("/api/texts")
      .then((r) => r.json())
      .then((d) => setTexts(d.texts || []))
      .catch(() => {});
    return () => clearInterval(infoTimer);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let socket: Socket | undefined;
    const poll = async () => {
      try {
        const responses = await Promise.all([fetch("/api/info"), fetch("/api/files"), fetch("/api/texts"), fetch("/api/peer", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(me),
        })]);
        if (responses.some((r) => !r.ok)) throw new Error("Host unavailable");
        const [info, f, t, p] = await Promise.all(responses.map((r) => r.json()));
        if (!stopped) { setHostInfo(info); setFiles(f.files); setTexts(t.texts); setPeers(p.peers); }
      } catch { /* retry when the network returns */ }
      finally { if (!stopped) timer = setTimeout(poll, 2000); }
    };
    const connect = async () => {
      try {
        const response = await fetch("/api/info");
        if (!response.ok) throw new Error("Host unavailable");
        const info = await response.json();
        if (stopped) return;
        setHostInfo(info);
        if (info.realtime === "polling") { void poll(); return; }
      } catch { if (!stopped) timer = setTimeout(connect, 2000); return; }
    socket = io({ transports: ["websocket", "polling"] });
    socketRef.current = socket;
    socket.on("connect", () => socket?.emit("peer:join", me));
    socket.on("peers", (p: Peer[]) => setPeers(p));
    socket.on("file:new", (f: FileMeta) => setFiles((prev) => (prev.some((x) => x.id === f.id) ? prev : [f, ...prev])));
    socket.on("text:new", (t: TextItem) => setTexts((prev) => (prev.some((x) => x.id === t.id) ? prev : [t, ...prev])));
    socket.on("file:delete", (id: string) => setFiles((prev) => prev.filter((f) => f.id !== id)));
    };
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.disconnect();
    };
  }, [me]);

  const uploadFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || busy) return;
    if (fileList.length > 20 || Array.from(fileList).some((f) => f.size > 1024 ** 3)) {
      setError("Choose up to 20 files, each no larger than 1 GB."); return;
    }
    setBusy(true);
    setError("");
    try {
    const fd = new FormData();
    Array.from(fileList).forEach((f) => fd.append("files", f));
    fd.append("from", JSON.stringify(me));
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    if (!res.ok) throw new Error("Upload failed. Check host storage and retry.");
    if (res.ok) {
      const data = await res.json();
      if (data.files)
        setFiles((prev) => {
          const existing = new Set(prev.map((p) => p.id));
          const news = (data.files as FileMeta[]).filter((f) => !existing.has(f.id));
          return [...news, ...prev];
        });
    }
    } catch (e) { setError(e instanceof Error ? e.message : "Upload failed. Check your connection."); }
    finally { setBusy(false); if (fileInputRef.current) fileInputRef.current.value = ""; }
  };

  const sendText = async () => {
    const t = textDraft.trim();
    if (!t || sending) return;
    setSending(true);
    setError("");
    try {
    const res = await fetch("/api/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: t, from: me }),
    });
    if (!res.ok) throw new Error("Message could not be sent. Please retry.");
    if (res.ok) {
      const data = await res.json();
      if (data.item) setTexts((prev) => (prev.some((x) => x.id === data.item.id) ? prev : [data.item, ...prev]));
      setTextDraft((current) => current.trim() === t ? "" : current);
    }
    } catch (e) { setError(e instanceof Error ? e.message : "Message could not be sent."); }
    finally { setSending(false); }
  };

  return (
    <div className="min-h-screen bg-brand-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 transition-colors">
      {/* Header */}
      <header className="sticky top-0 z-10 backdrop-blur bg-white/80 dark:bg-zinc-900/80 border-b border-brand-200 dark:border-zinc-800">
        <div className="mx-auto max-w-5xl px-3 sm:px-4 py-3 flex items-center justify-between gap-2 sm:gap-4">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            <div className="h-8 w-8 sm:h-9 sm:w-9 rounded-xl bg-brand-400 shadow-card shrink-0 flex items-center justify-center overflow-hidden p-1">
              <svg viewBox="0 0 100 100" className="w-full h-full" aria-hidden="true">
                <path d="M 18 46 A 45 45 0 0 1 82 46" fill="none" stroke="#18181B" strokeWidth="7" strokeLinecap="round"/>
                <path d="M 30 46 A 30 30 0 0 1 70 46" fill="none" stroke="#18181B" strokeWidth="7" strokeLinecap="round"/>
                <path d="M 40 46 A 17 17 0 0 1 60 46" fill="none" stroke="#18181B" strokeWidth="7" strokeLinecap="round"/>
                <circle cx="50" cy="57" r="10" fill="#18181B"/>
                <circle cx="50" cy="57" r="4.5" fill="#FACC15"/>
                <g fontFamily="Inter, system-ui, sans-serif" fontWeight="900" textAnchor="middle" fontSize="22">
                  <text x="30" y="86" fill="#18181B">H</text>
                  <text x="70" y="86" fill="#18181B">D</text>
                </g>
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="font-bold leading-none text-sm sm:text-base truncate">HotDrop</h1>
              <p className="text-[11px] sm:text-xs text-zinc-500 dark:text-zinc-400 truncate">
                {hostInfo ? `${hostInfo.hostName} • ${hostInfo.ip}:${hostInfo.port}` : "Connecting…"} • {peers.length} online
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Desktop: theme + peers + you */}
            <div className="hidden sm:flex items-center bg-zinc-100 dark:bg-zinc-800 rounded-full p-1 gap-1">
              {(["light", "system", "dark"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  title={t === "light" ? "Light" : t === "dark" ? "Dark" : "System (follow device)"}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-bold capitalize transition-colors ${theme === t ? "bg-white dark:bg-zinc-700 shadow text-zinc-900 dark:text-white" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"}`}
                >
                  {t === "light" ? "☀ Light" : t === "dark" ? "🌙 Dark" : "◎ Auto"}
                </button>
              ))}
            </div>
            <div className="hidden sm:flex -space-x-2">
              {peers.slice(0, 5).map((p) => (
                <div
                  key={p.id}
                  className="h-8 w-8 rounded-full border-2 border-white dark:border-zinc-900 flex items-center justify-center text-xs font-bold text-zinc-900"
                  style={{ background: p.color }}
                  title={p.name}
                >
                  {p.name.slice(0, 2).toUpperCase()}
                </div>
              ))}
            </div>
            <span className="hidden sm:inline-flex text-[11px] sm:text-xs bg-zinc-900 dark:bg-zinc-700 text-white px-2.5 sm:px-3 py-1.5 rounded-full whitespace-nowrap">
              You: {me.name}
            </span>
            {/* Mobile: hamburger */}
            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Open menu"
              className="sm:hidden h-9 w-9 rounded-xl bg-zinc-900 dark:bg-zinc-800 text-white flex items-center justify-center"
            >
              <span className="text-lg leading-none">{menuOpen ? "✕" : "☰"}</span>
            </button>
          </div>
        </div>
      </header>
      {/* Mobile drawer */}
      {menuOpen && (
        <div className="sm:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-0 h-full w-[82%] max-w-[320px] bg-white dark:bg-zinc-900 border-l border-zinc-200 dark:border-zinc-800 shadow-xl flex flex-col">
            <div className="p-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-xl bg-brand-400 flex items-center justify-center overflow-hidden p-1">
                  <svg viewBox="0 0 100 100" className="w-full h-full" aria-hidden="true">
                    <path d="M 18 46 A 45 45 0 0 1 82 46" fill="none" stroke="#18181B" strokeWidth="7" strokeLinecap="round"/>
                    <path d="M 30 46 A 30 30 0 0 1 70 46" fill="none" stroke="#18181B" strokeWidth="7" strokeLinecap="round"/>
                    <path d="M 40 46 A 17 17 0 0 1 60 46" fill="none" stroke="#18181B" strokeWidth="7" strokeLinecap="round"/>
                    <circle cx="50" cy="57" r="10" fill="#18181B"/><circle cx="50" cy="57" r="4.5" fill="#FACC15"/>
                  </svg>
                </div>
                <span className="font-bold text-sm">Menu</span>
              </div>
              <button onClick={() => setMenuOpen(false)} className="h-8 w-8 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">✕</button>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-5">
              <div>
                <p className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-2">You</p>
                <div className="flex items-center gap-3 bg-brand-50 dark:bg-zinc-800 rounded-xl p-3">
                  <div className="h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold text-zinc-900" style={{ background: me.color }}>
                    {me.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold text-sm truncate">{me.name}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{hostInfo ? `${hostInfo.ip}:${hostInfo.port}` : "Connecting…"}</p>
                  </div>
                </div>
              </div>
              <div>
                <p className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-2">Theme</p>
                <div className="flex bg-zinc-100 dark:bg-zinc-800 rounded-full p-1 gap-1">
                  {(["light", "system", "dark"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTheme(t)}
                      className={`flex-1 py-1.5 rounded-full text-xs font-bold capitalize transition-colors ${theme === t ? "bg-white dark:bg-zinc-700 shadow text-zinc-900 dark:text-white" : "text-zinc-500 dark:text-zinc-400"}`}
                    >
                      {t === "light" ? "☀ Light" : t === "dark" ? "🌙 Dark" : "◎ Auto"}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-2">Online • {peers.length}</p>
                {peers.length === 0 ? (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">No one else yet — invite by sharing the URL.</p>
                ) : (
                  <div className="space-y-2">
                    {peers.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 text-sm">
                        <div className="h-7 w-7 rounded-full flex items-center justify-center text-[11px] font-bold text-zinc-900" style={{ background: p.color }}>
                          {p.name.slice(0, 2).toUpperCase()}
                        </div>
                        <span className="truncate">{p.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-3">
                <p className="text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">How to share</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">Stay on this Hotspot/LAN. Files & links appear live. Host keeps app open.</p>
              </div>
            </div>
            <div className="p-4 border-t border-zinc-100 dark:border-zinc-800">
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 text-center">HotDrop • Offline • LAN only</p>
            </div>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-5xl px-3 sm:px-4 py-4 sm:py-6 grid gap-4 sm:gap-6">
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <p className="text-center text-[11px] sm:text-xs leading-relaxed text-zinc-500 dark:text-zinc-400 -mt-1 px-2 break-words">Stay on this page — files & links appear live. No data needed.</p>
        {hostInfo && (
          <div className="rounded-card bg-white dark:bg-zinc-800 border border-brand-200 dark:border-zinc-700 p-4 sm:p-6 flex flex-col sm:flex-row items-center gap-4 sm:gap-6 shadow-card">
            <div className="bg-white p-3 rounded-xl border border-brand-200 shrink-0">
              <QRCodeSVG value={`http://${hostInfo.ip}:${hostInfo.port}`} size={140} level="M" />
            </div>
            <div className="flex-1 min-w-0 text-center sm:text-left">
              <p className="font-extrabold text-sm sm:text-base">Scan to join — auto QR for this network</p>
              <p className="font-mono text-xs sm:text-sm bg-brand-50 dark:bg-zinc-900 border border-brand-200 dark:border-zinc-700 rounded-lg px-3 py-2 mt-2 break-all">{`http://${hostInfo.ip}:${hostInfo.port}`}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">On same Hotspot/WiFi • Updates when you switch network • No typing needed</p>
              <div className="flex gap-2 mt-3 justify-center sm:justify-start flex-wrap">
                <CopyButton text={`http://${hostInfo.ip}:${hostInfo.port}`} label="Copy link" className="text-xs bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 px-4 py-2 rounded-full font-bold" />
                <a href={`http://${hostInfo.ip}:${hostInfo.port}`} target="_blank" rel="noreferrer" className="text-xs bg-brand-400 text-zinc-900 px-4 py-2 rounded-full font-bold">Open</a>
              </div>
            </div>
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-4 sm:gap-6">
          {/* File drop */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              uploadFiles(e.dataTransfer.files);
            }}
            className={`rounded-card bg-white dark:bg-zinc-800 border-2 border-dashed p-4 sm:p-6 flex flex-col gap-4 shadow-card transition-colors ${dragOver ? "border-brand-500 bg-brand-50 dark:bg-zinc-700" : "border-brand-200 dark:border-zinc-700"}`}
          >
            <div className="flex items-start justify-between gap-3 sm:gap-4">
              <div className="min-w-0 flex-1">
                <h3 className="font-bold text-sm sm:text-base">Drop files</h3>
                <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400">Images, PDFs, videos — up to 1 GB each. Drag & drop or browse.</p>
              </div>
              <div className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl bg-brand-100 dark:bg-zinc-700 flex items-center justify-center text-lg sm:text-xl shrink-0">📁</div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="w-full sm:w-auto bg-brand-400 hover:bg-brand-500 text-zinc-900 font-bold px-5 py-2.5 rounded-full transition-colors shadow-sm text-sm sm:text-base"
              >
                {busy ? "Uploading…" : "Choose files"}
              </button>
              <span className="text-xs text-zinc-500 dark:text-zinc-400 text-center sm:text-left">or drop here</span>
            </div>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => uploadFiles(e.target.files)} />
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">Files stay on host device until cleared. LAN only.</p>
          </div>

          {/* Text / Link */}
          <div className="rounded-card bg-white dark:bg-zinc-800 border border-brand-200 dark:border-zinc-700 p-4 sm:p-6 flex flex-col gap-4 shadow-card">
            <div className="flex items-start justify-between gap-3 sm:gap-4">
              <div className="min-w-0 flex-1">
                <h3 className="font-bold text-sm sm:text-base">Send link or text</h3>
                <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400">Perfect for urgent test links — appears instantly.</p>
              </div>
              <div className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl bg-zinc-900 dark:bg-zinc-700 text-white flex items-center justify-center text-base sm:text-lg shrink-0">↗</div>
            </div>
            <textarea
              value={textDraft}
              onChange={(e) => setTextDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendText();
              }}
              placeholder="Paste https://test-link.com or any text… (Ctrl+Enter to send)"
              rows={4}
              className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 p-3 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-400 placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{isLink(textDraft) ? "🔗 Link detected" : textDraft ? "Text" : " "}</span>
              <button
                onClick={sendText}
                className="shrink-0 bg-zinc-900 dark:bg-white hover:bg-black dark:hover:bg-zinc-100 text-white dark:text-zinc-900 font-bold px-6 py-2.5 rounded-full transition-colors disabled:opacity-40 text-sm"
                disabled={!textDraft.trim() || sending}
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </div>

        {/* Live feed */}
        <section className="rounded-card bg-white dark:bg-zinc-800 border border-brand-200 dark:border-zinc-700 shadow-card overflow-hidden">
          <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-zinc-100 dark:border-zinc-700 flex items-center justify-between">
            <h3 className="font-bold text-sm sm:text-base">Live feed</h3>
            <span className="text-xs bg-brand-100 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 px-2.5 py-1 rounded-full">{allItems.length} items</span>
          </div>
          {allItems.length === 0 ? (
            <div className="px-4 sm:px-6 py-10 sm:py-12 text-center">
              <div className="h-12 w-12 rounded-full bg-brand-100 dark:bg-zinc-700 mx-auto flex items-center justify-center text-xl">✨</div>
              <p className="font-semibold mt-3">No shares yet</p>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 px-4">Files and links will appear here live as anyone shares.</p>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-700">
              {allItems.map((item) =>
                item.kind === "file" ? (
                  <li key={item.data.id} className="px-4 sm:px-6 py-3 sm:py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
                    <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-1">
                      <div className="h-10 w-10 sm:h-11 sm:w-11 rounded-xl bg-brand-400 flex items-center justify-center font-bold text-zinc-900 shrink-0 text-sm">
                        {(item.data.name.split(".").pop() || "F").slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate text-sm break-all">{item.data.name}</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                          {formatBytes(item.data.size)} • from {item.data.from.name} • {new Date(item.data.at).toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                    <a
                      href={item.data.url}
                      download={item.data.name}
                      className="w-full sm:w-auto text-center shrink-0 bg-brand-400 hover:bg-brand-500 text-zinc-900 font-bold px-4 py-2.5 sm:py-2 rounded-full text-sm transition-colors"
                    >
                      Download
                    </a>
                  </li>
                ) : (
                  <li key={item.data.id} className="px-4 sm:px-6 py-3 sm:py-4 flex items-start gap-3 sm:gap-4">
                    <div className="h-8 w-8 sm:h-9 sm:w-9 rounded-full flex items-center justify-center text-xs font-bold text-zinc-900 shrink-0" style={{ background: item.data.from.color }}>
                      {item.data.from.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 truncate">
                        {item.data.from.name} • {new Date(item.data.at).toLocaleTimeString()}
                      </p>
                      <Truncated text={item.data.text} max={item.data.type === "link" ? 80 : 200} isLink={item.data.type === "link"} />
                      <div className="mt-2 flex flex-wrap gap-2">
                        <CopyButton text={item.data.text} className="text-xs bg-white dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-600 text-zinc-900 dark:text-white px-3 py-1.5 rounded-full" />
                        {item.data.type === "link" && (
                          <a href={item.data.text} target="_blank" rel="noreferrer" className="text-xs bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 px-3 py-1.5 rounded-full">
                            Open
                          </a>
                        )}
                      </div>
                    </div>
                  </li>
                )
              )}
            </ul>
          )}
        </section>

        <footer className="mt-2 border-t border-brand-200 dark:border-zinc-800 pt-4 pb-6 text-center">
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            built by <span className="font-bold">Danetech</span> • <a href="https://danetech.netlify.app/" target="_blank" rel="noreferrer" className="underline hover:text-brand-500">contact developer</a> • <a href="tel:+2349041197194" className="underline hover:text-brand-500">+2349041197194</a>
          </p>
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">HotDrop • Yellow • Offline • LAN only • Host IP on host device</p>
        </footer>
      </main>
    </div>
  );
}

