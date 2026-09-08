/**
 * Type declaration for Jenny's orchestrator (the .js files beside this are
 * verbatim copies and must not be edited — see ../README.md). Shapes below are
 * read off the JavaScript, not invented.
 */
import type { EventEmitter } from "node:events";

export interface OrchestratorOptions {
  pythonPort?: number;
  wsPort?: number;
  isDev?: boolean;
  workspaceDir?: string;
  /** Interpreter used in dev mode (`python -m uvicorn ...`). */
  pythonPath?: string;
  /** cwd for the dev spawn; defaults to `<workspaceDir>/backend`. */
  backendDir?: string | null;
}

export type ProcessStatus = "stopped" | "starting" | "running" | "crashed";
export type HealthState = "healthy" | "unhealthy" | "unknown";
/** What HealthMonitor.getStatus() actually returns (read off the source). */
export interface HealthStatus {
  status: HealthState;
  consecutiveFailures: number;
}

export interface OrchestratorStatus {
  python: ProcessStatus;
  health: HealthStatus;
  uptime: number;
}

export interface LogEntry {
  source: string;
  level: "info" | "error";
  message: string;
}

declare class ProcessManager extends EventEmitter {
  constructor(options?: OrchestratorOptions);
  start(): void;
  stop(): void;
  restart(): void;
  getStatus(): ProcessStatus;
  getUptime(): number;
}

declare class HealthMonitor extends EventEmitter {
  constructor(port?: number, interval?: number);
  check(): Promise<{ healthy: boolean; data?: unknown; statusCode?: number; error?: string }>;
  waitUntilReady(maxRetries?: number, delay?: number): Promise<boolean>;
  startMonitoring(): void;
  stopMonitoring(): void;
  getStatus(): HealthStatus;
}

declare class LogAggregator extends EventEmitter {
  constructor(options?: { logDir?: string; maxFileSize?: number; maxFiles?: number });
  write(source: string, level: string, message: string): void;
  getRecent(count?: number): Array<{ timestamp: string; source: string; level: string; message: string }>;
}

declare class Orchestrator extends EventEmitter {
  constructor(options?: OrchestratorOptions);
  readonly options: Required<OrchestratorOptions>;
  readonly processManager: ProcessManager;
  readonly healthMonitor: HealthMonitor;
  readonly logAggregator: LogAggregator;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  restart(): Promise<boolean>;
  getStatus(): OrchestratorStatus;
  on(event: "python:started" | "python:healthy" | "python:unhealthy" | "python:recovering", listener: () => void): this;
  on(event: "python:stopped" | "python:crashed", listener: (code: number | null) => void): this;
  on(event: "log", listener: (entry: LogEntry) => void): this;
}

export = Orchestrator;
