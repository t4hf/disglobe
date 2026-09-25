"use strict";

const { app, BrowserWindow, ipcMain, shell, Notification, desktopCapturer, dialog } = require("electron");
const path = require("path");

/* Disglobe app — the whole program lives in disglobe.html + server.js. */
const DISGLOBE = true;
const HOST = process.argv.includes("--host");

let splashWin = null;

function createSplash() {
  splashWin = new BrowserWindow({
    width: 500,
    height: 350,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    center: true,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  splashWin.loadFile("splash.html");
  return splashWin;
}

function fadeOutSplash() {
  if (!splashWin || splashWin.isDestroyed()) { splashWin = null; return; }
  try {
    splashWin.webContents.executeJavaScript("document.body.classList.add('fading');").catch(() => {});
  } catch {}
  const win = splashWin;
  splashWin = null;
  setTimeout(() => { try { win.close(); } catch {} }, 500);
}

/* Soft two-note chime (C5 → G5) played as the main window fades in.
   Synthesized with Web Audio so no sound file needs bundling. */
function playRevealChime(win) {
  const js = `(function () {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var now = ctx.currentTime;
      [[523.25, 0], [784.00, 0.18]].forEach(function (n) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = n[0];
        var t = now + n[1];
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.06, t + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t); osc.stop(t + 1.2);
      });
      setTimeout(function () { ctx.close().catch(function(){}); }, 1600);
    } catch (e) {}
  })();`;
  win.webContents.executeJavaScript(js).catch(() => {});
}

function createWindow(loadUrl) {
  // packaged: icon.ico lives next to app.asar inside app.asar.unpacked (asarUnpack)
  let iconPath = path.join(__dirname, "build", "disglobe.ico");
  if (iconPath.includes("app.asar" + path.sep))
    iconPath = iconPath.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    show: false, /* hidden until splash finishes + page loads — the handoff */
    backgroundColor: "#17121f",
    icon: iconPath,
    autoHideMenuBar: true,
    title: "Disglobe",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (loadUrl) win.loadURL(loadUrl);
  else win.loadFile("disglobe.html");
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  /* ---- splash → main handoff ----
     Reveal the main window only after (a) the splash animation has had its
     ~2.7s runtime and (b) the main page finished loading its backend data.
     Then fade the splash out and fade the main window in. */
  const SPLASH_MS = 2700;
  let pageReady = false;
  let splashDone = false;
  let revealed = false;
  const tryReveal = () => {
    if (revealed || win.isDestroyed()) return;
    if (!pageReady || !splashDone) return;
    revealed = true;
    fadeOutSplash();
    /* fade-in: the page rendered while hidden, so arm a 0→1 opacity
       transition right before showing */
    win.webContents.insertCSS("html { opacity: 0; transition: opacity 0.5s ease; }")
      .then(() => {
        win.show();
        try { win.focus(); } catch {}
        win.webContents.executeJavaScript(
          "document.documentElement.style.opacity = '1';"
        ).catch(() => {});
        playRevealChime(win);
      })
      .catch(() => {
        /* fallback: just show without the fade */
        win.show();
        try { win.focus(); } catch {}
        playRevealChime(win);
      });
  };
  const timerDone = () => { splashDone = true; tryReveal(); };
  const splashTimer = setTimeout(timerDone, SPLASH_MS);
  win.webContents.once("did-finish-load", () => {
    /* give the page a beat to fire its own boot/WS/data fetches so the
       chat workspace isn't blank when revealed */
    setTimeout(() => { pageReady = true; tryReveal(); }, 350);
  });
  /* failsafe: never leave the user stranded on the splash if the page hangs
     (e.g. remote server asleep on Render's free tier) */
  setTimeout(() => { pageReady = true; splashDone = true; tryReveal(); }, SPLASH_MS + 8000);
  win.once("closed", () => { clearTimeout(splashTimer); splashDone = true; });
  return win;
}

/* ---- server URL resolution (for building a cloud-connected exe) ----
   Priority: DISGLOBE_SERVER_URL env var > disglobe.config.json "serverUrl" > embedded local.
   Put your Render/cloud URL in disglobe.config.json next to main.js before building,
   or launch with DISGLOBE_SERVER_URL set — then the exe connects to that online server
   instead of hosting its own. Cloud mode skips the embedded server entirely. */
function resolveServerUrl() {
  if (process.env.DISGLOBE_SERVER_URL) return process.env.DISGLOBE_SERVER_URL.replace(/\/$/, "");
  try {
    const cfg = JSON.parse(require("fs").readFileSync(path.join(__dirname, "disglobe.config.json"), "utf8"));
    if (cfg && typeof cfg.serverUrl === "string" && cfg.serverUrl.trim()) return cfg.serverUrl.trim().replace(/\/$/, "");
  } catch {}
  return null; // null = host our own embedded server
}
const REMOTE_URL = resolveServerUrl();

app.whenReady().then(() => {
  /* Show the cosmic splash immediately, before any main-window work begins. */
  createSplash();
  /* Disglobe notification bridges */
  let badgeCount = 0;
  ipcMain.on("disglobe:lan-ip", (e) => { e.returnValue = global.__disglobeLanIp || "localhost"; });
  /* client asks which server to use (remote cloud URL or embedded local) */
  ipcMain.on("disglobe:server-url", (e) => { e.returnValue = REMOTE_URL; });
  /* screenshare: Electron needs desktopCapturer (no native getDisplayMedia picker in the exe) */
  ipcMain.handle("disglobe:screen-sources", async () => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } });
      if (!sources.length) return null;
      const options = sources.map((s, i) => ({
        id: s.id, name: s.name,
        detail: s.id.startsWith("screen:") ? "Entire Screen" : "Window",
        thumb: s.thumbnail.toDataURL(),
      }));
      /* simple chooser window via dialog */
      const win = BrowserWindow.getAllWindows()[0];
      const picked = await dialog.showMessageBox(win, {
        type: "question",
        title: "Share your screen",
        message: "What do you want to share?",
        buttons: [...options.map(o => o.detail + ": " + o.name).slice(0, 10), "Cancel"],
        defaultId: 0, cancelId: options.length,
        noLink: true,
      });
      if (picked.response >= options.length) return null;
      return options[picked.response];
    } catch (e) { console.error("screen sources failed:", e); return null; }
  });
  ipcMain.on("disglobe:notify", (_e, { title, body }) => {
    if (Notification.isSupported()) new Notification({ title: String(title || "Disglobe"), body: String(body || ""), icon: undefined, silent: true }).show();
  });
  ipcMain.on("disglobe:badge", (_e, count) => {
    badgeCount = Number(count) || 0;
    try {
      if (process.platform === "win32") app.setBadgeCount?.(badgeCount);
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.setOverlayIcon?.(null, badgeCount ? String(badgeCount) : "");
    } catch {}
  });

  if (REMOTE_URL) {
    /* Cloud mode: the exe is a pure client of your online server (PostgreSQL + WebSocket
       + WebRTC live there). Everyone worldwide lands on the same accounts & chat. */
    console.log(`\n  🌐 Disglobe connecting to online server → ${REMOTE_URL}\n`);
    createWindow(REMOTE_URL);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(REMOTE_URL);
    });
  } else {
    /* Self-host mode (default): embedded server, so double-clicking the exe just works —
       accounts, friends, and messages live in disglobe-data/ next to the app. */
    let startServer;
    try { startServer = require("./server.js").startServer; }
    catch { console.error("[disglobe] server.js missing — cannot self-host. Set serverUrl in disglobe.config.json."); app.quit(); return; }
    startServer(3849);
    const { networkInterfaces } = require("os");
    const nets = networkInterfaces();
    let lanIp = "localhost";
    for (const list of Object.values(nets)) for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) { lanIp = n.address; break; }
    }
    console.log(`\n  🌐 Disglobe is hosting → http://localhost:3849\n     Friends on your network can join at → http://${lanIp}:3849\n     (They register there, then add each other with @usernames.)\n`);
    /* stash the LAN address so the client can show a real "invite your friends" panel */
    global.__disglobeLanIp = lanIp;
    createWindow("http://localhost:3849");
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow("http://localhost:3849");
    });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || HOST) app.quit();
});
