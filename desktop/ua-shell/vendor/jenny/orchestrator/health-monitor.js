/**
 * Jenny Health Monitor
 * Polls the Python runtime /health endpoint.
 * Emits events: healthy, unhealthy, recovering (auto-restart trigger).
 */

const http = require('http');
const EventEmitter = require('events');

class HealthMonitor extends EventEmitter {
  constructor(port = 18764, interval = 3000) {
    super();
    this.port = port;
    this.interval = interval;
    this.timer = null;
    this.consecutiveFailures = 0;
    this.maxFailures = 3;
    this.status = 'unknown'; // healthy, unhealthy, unknown
  }

  async check() {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${this.port}/health`, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve({ healthy: true, data: JSON.parse(body) });
          } else {
            resolve({ healthy: false, statusCode: res.statusCode });
          }
        });
      });

      req.on('error', (err) => {
        resolve({ healthy: false, error: err.message });
      });

      req.setTimeout(2000, () => {
        req.destroy();
        resolve({ healthy: false, error: 'timeout' });
      });
    });
  }

  async waitUntilReady(maxRetries = 30, delay = 500) {
    for (let i = 0; i < maxRetries; i++) {
      const result = await this.check();
      if (result.healthy) {
        this.status = 'healthy';
        this.consecutiveFailures = 0;
        console.log('[HealthMonitor] ✅ Python runtime is ready');
        this.emit('healthy');
        return true;
      }
      await new Promise(r => setTimeout(r, delay));
    }
    console.error('[HealthMonitor] ❌ Python runtime failed to start');
    this.status = 'unhealthy';
    return false;
  }

  startMonitoring() {
    if (this.timer) return;

    this.timer = setInterval(async () => {
      const result = await this.check();

      if (result.healthy) {
        if (this.status !== 'healthy') {
          console.log('[HealthMonitor] Runtime recovered');
        }
        this.status = 'healthy';
        this.consecutiveFailures = 0;
        this.emit('healthy');
      } else {
        this.consecutiveFailures++;
        this.status = 'unhealthy';
        this.emit('unhealthy', { failures: this.consecutiveFailures });

        if (this.consecutiveFailures >= this.maxFailures) {
          console.error(`[HealthMonitor] ${this.maxFailures} consecutive failures — triggering recovery`);
          this.consecutiveFailures = 0;
          this.emit('recovering');
        }
      }
    }, this.interval);
  }

  stopMonitoring() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus() {
    return {
      status: this.status,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

module.exports = HealthMonitor;
