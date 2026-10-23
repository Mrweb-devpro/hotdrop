const { app, BrowserWindow, Menu, Tray, shell, dialog, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { start: startServer, server, getLocalIP, PORT } = require("../server/index.cjs");

let win, tray;
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 750, minWidth: 900, minHeight: 600,
    backgroundColor: '#FFFBEB',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const url = `http://localhost:${PORT}`;
  win.loadURL(url);
  win.on('closed', ()=> win=null);
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'icon.png');
    if (!fs.existsSync(iconPath)) return;
    tray = new Tray(iconPath);
    const ip = getLocalIP();
    const menu = Menu.buildFromTemplate([
      { label: `HotDrop — http://${ip}:${PORT}`, enabled: false },
      { type: 'separator' },
      { label: 'Copy Network URL', click: ()=> clipboard.writeText(`http://${ip}:${PORT}`) },
      { label: 'Open in Browser', click: ()=> shell.openExternal(`http://localhost:${PORT}`) },
      { type: 'separator' },
      { label: 'Quit HotDrop', click: ()=> app.quit() }
    ]);
    tray.setToolTip(`HotDrop — http://${ip}:${PORT}`);
    tray.setContextMenu(menu);
    tray.on('click', ()=> win && win.show());
  } catch {}
}

app.whenReady().then(async ()=>{
  try { await startServer(); } catch (error) { dialog.showErrorBox("HotDrop Port Error", error.message); app.quit(); return; }
  createWindow();
  createTray();
  app.on('activate', ()=>{ if(BrowserWindow.getAllWindows().length===0) createWindow(); });
});

app.on('window-all-closed', ()=>{
  if (process.platform !== 'darwin') {
    // keep server running in tray even if window closed? For now quit
    // uncomment to keep running: return;
    app.quit();
  }
});

app.on('before-quit', ()=>{
  try { server && server.close(); } catch {}
});

