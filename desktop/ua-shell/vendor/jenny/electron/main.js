/**
 * Jenny — Electron Main Process (Framework Core)
 * This is the core Electron entry point used by Jenny apps.
 * Thin shell: window management, IPC, delegates to Orchestrator for Python.
 */

const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const Orchestrator = require('../orchestrator');

const isDev = process.env.JENNY_DEV === 'true' || !app.isPackaged;

// Load project config
let projectConfig = {};
try {
  projectConfig = require(path.join(process.cwd(), 'jenny.config.json'));
} catch {
  projectConfig = {
    appName: 'Jenny App',
    python: { port: 18764, wsPort: 18765 },
    electron: { width: 1280, height: 800, devPort: 3000 },
  };
}

const PYTHON_PORT = projectConfig.python?.port || 18764;
const WS_PORT = projectConfig.python?.wsPort || 18765;
const DEV_PORT = projectConfig.electron?.devPort || 3000;

let mainWindow = null;
let orchestrator = null;

// ─── Orchestrator Setup ─────────────────────────────────────────
function createOrchestrator() {
  orchestrator = new Orchestrator({
    pythonPort: PYTHON_PORT,
    wsPort: WS_PORT,
    isDev,
    workspaceDir: process.cwd(),
    backendDir: path.join(process.cwd(), 'backend'),
  });

  orchestrator.on('python:started', () => {
    console.log('🐍 Python runtime started');
    if (mainWindow) {
      mainWindow.webContents.send('app:python-status', 'started');
    }
  });

  orchestrator.on('python:healthy', () => {
    if (mainWindow) {
      mainWindow.webContents.send('app:python-status', 'healthy');
    }
  });

  orchestrator.on('python:crashed', (code) => {
    console.error(`🐍 Python crashed with code ${code}`);
    if (mainWindow) {
      mainWindow.webContents.send('app:python-status', 'crashed');
    }
  });

  orchestrator.on('log', (entry) => {
    if (mainWindow && isDev) {
      mainWindow.webContents.send('app:log', entry);
    }
  });
}

// ─── Window ─────────────────────────────────────────────────────
function createWindow() {
  const { width = 1280, height = 800 } = projectConfig.electron || {};

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 800,
    minHeight: 600,
    title: projectConfig.appName || 'Jenny App',
    backgroundColor: '#0f0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
  });

  if (isDev) {
    mainWindow.loadURL(`http://localhost:${DEV_PORT}`);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'frontend', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Menu ───────────────────────────────────────────────────────
function createMenu() {
  const template = require('./menu')(isDev, orchestrator);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── IPC Handlers ───────────────────────────────────────────────
function setupIPC() {
  ipcMain.handle('app:get-config', () => ({
    pythonPort: PYTHON_PORT,
    wsPort: WS_PORT,
    isDev,
    platform: process.platform,
    appName: projectConfig.appName,
  }));

  ipcMain.handle('app:get-status', () => {
    return orchestrator ? orchestrator.getStatus() : { python: 'stopped' };
  });

  ipcMain.handle('app:restart-python', async () => {
    if (orchestrator) {
      return await orchestrator.restart();
    }
    return false;
  });

  ipcMain.handle('app:open-file-dialog', async (event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      ...options,
    });
    return result;
  });

  ipcMain.handle('app:open-directory-dialog', async (event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      ...options,
    });
    return result;
  });
}

// ─── App Lifecycle ──────────────────────────────────────────────
app.whenReady().then(async () => {
  createOrchestrator();
  setupIPC();

  const ready = await orchestrator.start();
  if (!ready) {
    console.error('❌ Failed to start Python runtime');
  }

  createWindow();
  createMenu();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('will-quit', async () => {
  if (orchestrator) {
    await orchestrator.stop();
  }
});
