"use strict";
// Test-only application fixture. Updater calls use real IPC and the real main service.
const { contextBridge, ipcRenderer } = require("electron");
const expose = contextBridge.exposeInMainWorld.bind(contextBridge);
contextBridge.exposeInMainWorld = (name, value) => {
  if (name === "jellyfin") value = { ...value, updates: {
    getState: () => ipcRenderer.invoke("test-updates:get"),
    check: () => ipcRenderer.invoke("test-updates:check"),
    install: () => ipcRenderer.invoke("test-updates:install"),
    defer: () => ipcRenderer.invoke("test-updates:defer"),
    subscribe: listener => { const receive = (_event, state) => listener(state); ipcRenderer.on("test-updates:changed", receive); return () => ipcRenderer.removeListener("test-updates:changed", receive); },
  } };
  expose(name, value);
};
require("./product-polish-preload.cjs");
