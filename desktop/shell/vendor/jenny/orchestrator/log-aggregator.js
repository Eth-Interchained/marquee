/**
 * Jenny Log Aggregator
 * Centralized logging for Python and Electron processes.
 * Writes to rotating log files and provides a stream for the renderer dev console.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class LogAggregator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logDir = options.logDir || path.join(process.cwd(), '.jenny', 'logs');
    this.maxFileSize = options.maxFileSize || 5 * 1024 * 1024; // 5MB
    this.maxFiles = options.maxFiles || 5;
    this.buffer = [];
    this.maxBufferSize = 1000;

    this._ensureDir();
  }

  _ensureDir() {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
    } catch {}
  }

  write(source, level, message) {
    const timestamp = new Date().toISOString();
    const entry = { timestamp, source, level, message };

    // Buffer for renderer streaming
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }

    // Emit for real-time listeners
    this.emit('log', entry);

    // Write to file
    const line = `[${timestamp}] [${source}] [${level}] ${message}\n`;
    const logFile = path.join(this.logDir, `jenny-${source}.log`);

    try {
      fs.appendFileSync(logFile, line);
      this._rotateIfNeeded(logFile);
    } catch {}
  }

  getRecent(count = 100) {
    return this.buffer.slice(-count);
  }

  _rotateIfNeeded(filePath) {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > this.maxFileSize) {
        const ext = path.extname(filePath);
        const base = filePath.slice(0, -ext.length);

        // Rotate existing files
        for (let i = this.maxFiles - 1; i >= 1; i--) {
          const src = `${base}.${i}${ext}`;
          const dst = `${base}.${i + 1}${ext}`;
          if (fs.existsSync(src)) {
            if (i + 1 >= this.maxFiles) {
              fs.unlinkSync(src);
            } else {
              fs.renameSync(src, dst);
            }
          }
        }

        fs.renameSync(filePath, `${base}.1${ext}`);
      }
    } catch {}
  }
}

module.exports = LogAggregator;
