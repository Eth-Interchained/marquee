/**
 * Jenny — Preload Script (Framework Core)
 * Exposes window.jenny API via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

const VALID_INVOKE_CHANNELS = [
  'app:get-config',
  'app:get-status',
  'app:restart-python',
  'app:open-file-dialog',
  'app:open-directory-dialog',
];

const VALID_LISTEN_CHANNELS = [
  'app:python-status',
  'app:update-available',
  'app:log',
];

contextBridge.exposeInMainWorld('jenny', {
  /**
   * IPC invoke — request/response pattern.
   * @param {string} channel
   * @param  {...any} args
   * @returns {Promise<any>}
   */
  invoke: (channel, ...args) => {
    if (VALID_INVOKE_CHANNELS.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error(`Invalid IPC channel: ${channel}`));
  },

  /**
   * IPC listener — one-way events from main process.
   * @param {string} channel
   * @param {Function} callback
   */
  on: (channel, callback) => {
    if (VALID_LISTEN_CHANNELS.includes(channel)) {
      const handler = (event, ...args) => callback(...args);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    }
  },

  /**
   * Platform and environment info.
   */
  platform: process.platform,
  isDev: process.env.JENNY_DEV === 'true',
  version: '1.0.0',
});
