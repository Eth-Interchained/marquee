/**
 * Preload for the browser chrome. The toolbar is shell UI, not page content: it
 * receives state pushes and sends commands, and nothing else.
 */

import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type ChromeCommand, type ChromeState } from "../ipc";

contextBridge.exposeInMainWorld("uaChrome", {
  onState: (listener: (state: ChromeState) => void) => {
    ipcRenderer.on(CHANNELS.chromeState, (_event, state: ChromeState) => listener(state));
  },
  send: (command: ChromeCommand) => ipcRenderer.send(CHANNELS.chromeCommand, command),
});
