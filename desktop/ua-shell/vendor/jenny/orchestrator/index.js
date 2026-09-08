/**
 * Jenny Orchestrator
 * Manages Python runtime lifecycle from Node.js.
 */

const ProcessManager = require('./process-manager');
const HealthMonitor = require('./health-monitor');
const LogAggregator = require('./log-aggregator');
const EventEmitter = require('events');

class Orchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      pythonPort: options.pythonPort || 18764,
      wsPort: options.wsPort || 18765,
      isDev: options.isDev || false,
      workspaceDir: options.workspaceDir || process.cwd(),
      pythonPath: options.pythonPath || 'python',
      backendDir: options.backendDir || null,
      ...options,
    };

    this.processManager = new ProcessManager(this.options);
    this.healthMonitor = new HealthMonitor(this.options.pythonPort);
    this.logAggregator = new LogAggregator();

    // Wire events
    this.processManager.on('started', () => this.emit('python:started'));
    this.processManager.on('stopped', (code) => this.emit('python:stopped', code));
    this.processManager.on('crashed', (code) => this.emit('python:crashed', code));
    this.processManager.on('stdout', (data) => {
      this.logAggregator.write('python', 'stdout', data);
      this.emit('log', { source: 'python', level: 'info', message: data });
    });
    this.processManager.on('stderr', (data) => {
      this.logAggregator.write('python', 'stderr', data);
      this.emit('log', { source: 'python', level: 'error', message: data });
    });

    this.healthMonitor.on('healthy', () => this.emit('python:healthy'));
    this.healthMonitor.on('unhealthy', () => this.emit('python:unhealthy'));
    this.healthMonitor.on('recovering', () => {
      this.emit('python:recovering');
      this.processManager.restart();
    });
  }

  async start() {
    console.log('🧬 Jenny Orchestrator starting...');
    this.processManager.start();
    const ready = await this.healthMonitor.waitUntilReady();
    if (ready) {
      this.healthMonitor.startMonitoring();
    }
    return ready;
  }

  async stop() {
    console.log('🧬 Jenny Orchestrator stopping...');
    this.healthMonitor.stopMonitoring();
    this.processManager.stop();
  }

  async restart() {
    console.log('🧬 Restarting Python runtime...');
    this.healthMonitor.stopMonitoring();
    this.processManager.restart();
    const ready = await this.healthMonitor.waitUntilReady();
    if (ready) {
      this.healthMonitor.startMonitoring();
    }
    return ready;
  }

  getStatus() {
    return {
      python: this.processManager.getStatus(),
      health: this.healthMonitor.getStatus(),
      uptime: this.processManager.getUptime(),
    };
  }
}

module.exports = Orchestrator;
module.exports.ProcessManager = ProcessManager;
module.exports.HealthMonitor = HealthMonitor;
module.exports.LogAggregator = LogAggregator;
