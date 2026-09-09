/**
 * Jenny Process Manager
 * Spawns, monitors, and manages the Python runtime process.
 * Handles crash recovery with exponential backoff.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

/**
 * Dynamically locate the Python executable in the packaged resources.
 * Tries all known PyInstaller output conventions before falling back to a
 * recursive directory scan — survives naming changes and manual builds.
 */
function findPythonExe(resourcesPath) {
  const pythonDir = path.join(resourcesPath, 'python');
  const isWin = process.platform === 'win32';
  const ext = isWin ? '.exe' : '';

  // Known candidate paths — matches build.js canonical output: --name jenny --onedir
  const candidates = [
    path.join(pythonDir, 'jenny', `jenny${ext}`),   // --onedir (primary)
    path.join(pythonDir, `jenny${ext}`),             // --onefile fallback
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      console.log(`[ProcessManager] Found Python exe: ${c}`);
      return c;
    }
  }

  // Last resort: recursive scan for first executable in python dir
  const found = findExeRecursive(pythonDir, ext);
  if (found) {
    console.log(`[ProcessManager] Discovered Python exe via scan: ${found}`);
    return found;
  }

  console.error(`[ProcessManager] No Python executable found in ${pythonDir}`);
  return null;
}

function findExeRecursive(dir, ext) {
  if (!fs.existsSync(dir)) return null;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findExeRecursive(full, ext);
        if (found) return found;
      } else if (ext ? entry.name.endsWith(ext) : !entry.name.includes('.')) {
        return full;
      }
    }
  } catch { /* permission errors, skip */ }
  return null;
}


class ProcessManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.process = null;
    this.status = 'stopped'; // stopped, starting, running, crashed
    this.startTime = null;
    this.restartCount = 0;
    this.maxRestarts = 5;
    this.baseDelay = 1000;
    this._intentionalStop = false;
  }

  start() {
    if (this.process && this.status === 'running') {
      console.log('[ProcessManager] Already running');
      return;
    }

    this.status = 'starting';
    this._intentionalStop = false;

    const { isDev, pythonPath, pythonPort, wsPort, backendDir, workspaceDir } = this.options;

    let cmd, args, cwd;

    if (isDev) {
      cmd = pythonPath || 'python';
      args = [
        '-m', 'uvicorn', 'app:app',
        '--host', '127.0.0.1',
        '--port', String(pythonPort),
        '--reload',
      ];
      cwd = backendDir || path.join(workspaceDir, 'backend');
    } else {
      // Production: dynamically locate the PyInstaller executable
      // Searches resources/python/ for jenny-runtime.exe, app.exe, or any .exe
      cmd = findPythonExe(process.resourcesPath || path.join(__dirname, '..', '..'));
      if (!cmd) {
        this.status = 'crashed';
        this.emit('crashed', -1);
        throw new Error('Python executable not found in resources/python/. Run jenny build first.');
      }
      args = ['--port', String(pythonPort)];
      cwd = workspaceDir;
    }

    console.log(`[ProcessManager] Spawning: ${cmd} ${args.join(' ')}`);
    console.log(`[ProcessManager] CWD: ${cwd}`);

    try {
      this.process = spawn(cmd, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          JENNY_PORT: String(pythonPort),
          JENNY_WS_PORT: String(wsPort),
          JENNY_WORKSPACE_DIR: workspaceDir,
          PYTHONUNBUFFERED: '1',
        },
        windowsHide: true,
      });
    } catch (err) {
      console.error(`[ProcessManager] Failed to spawn: ${err.message}`);
      this.status = 'crashed';
      this.emit('crashed', -1);
      return;
    }

    this.startTime = Date.now();
    this.status = 'running';
    this.emit('started');

    this.process.stdout.on('data', (data) => {
      this.emit('stdout', data.toString().trim());
    });

    this.process.stderr.on('data', (data) => {
      this.emit('stderr', data.toString().trim());
    });

    this.process.on('close', (code) => {
      this.process = null;
      if (this._intentionalStop) {
        this.status = 'stopped';
        this.emit('stopped', code);
      } else {
        this.status = 'crashed';
        this.emit('crashed', code);
        this._handleCrash();
      }
    });

    this.process.on('error', (err) => {
      console.error(`[ProcessManager] Process error: ${err.message}`);
      this.status = 'crashed';
      this.emit('crashed', -1);
    });
  }

  stop() {
    if (!this.process) return;
    this._intentionalStop = true;

    console.log('[ProcessManager] Stopping Python...');

    // Graceful: SIGTERM → wait 3s → SIGKILL
    this.process.kill('SIGTERM');

    setTimeout(() => {
      if (this.process && !this.process.killed) {
        console.log('[ProcessManager] Force killing Python...');
        this.process.kill('SIGKILL');
      }
    }, 3000);
  }

  restart() {
    this.stop();
    setTimeout(() => this.start(), 500);
  }

  _handleCrash() {
    if (this.restartCount >= this.maxRestarts) {
      console.error(`[ProcessManager] Max restarts (${this.maxRestarts}) reached. Giving up.`);
      return;
    }

    this.restartCount++;
    const delay = this.baseDelay * Math.pow(2, this.restartCount - 1);
    console.log(`[ProcessManager] Restart attempt ${this.restartCount}/${this.maxRestarts} in ${delay}ms`);

    setTimeout(() => this.start(), delay);
  }

  getStatus() {
    return this.status;
  }

  getUptime() {
    if (!this.startTime || this.status !== 'running') return 0;
    return Date.now() - this.startTime;
  }
}

module.exports = ProcessManager;
