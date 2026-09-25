"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/* Disglobe bridges: OS notifications + taskbar badge, wired in main.js */
contextBridge.exposeInMainWorld("disglobeNotify", (title, body) =>
  ipcRenderer.send("disglobe:notify", { title, body }));
contextBridge.exposeInMainWorld("disglobeBadge", (count) =>
  ipcRenderer.send("disglobe:badge", count));
/* screenshare source picker (Electron's desktopCapturer) */
contextBridge.exposeInMainWorld("disglobeScreenSources", () =>
  ipcRenderer.invoke("disglobe:screen-sources"));
/* LAN address of this machine's hosted server, so the client can show a real join link */
contextBridge.exposeInMainWorld("disglobeLanIp", () =>
  ipcRenderer.sendSync("disglobe:lan-ip"));
/* the server URL baked into this build (cloud mode) or null (self-host mode) */
contextBridge.exposeInMainWorld("disglobeServerUrl", () =>
  ipcRenderer.sendSync("disglobe:server-url"));
