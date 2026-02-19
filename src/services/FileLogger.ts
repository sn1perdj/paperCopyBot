import * as fs from 'fs';
import * as path from 'path';

/**
 * FileLogger — Persistent .txt audit logger for every bot action.
 *
 * Writes timestamped entries to logs/bot_YYYY-MM-DD.txt
 * This runs independently of DEBUG_LOGS — it ALWAYS logs.
 *
 * Categories:
 *   BOOT     — Process start, service init
 *   SHUTDOWN — Graceful/forced shutdown, signals
 *   CRASH    — Uncaught exceptions, unhandled rejections
 *   TRADE    — BUY/SELL executions, skips
 *   CLOSE    — Position closures (manual, resolution, system)
 *   LIFECYCLE— State transitions (OPEN → PENDING → CLOSED)
 *   WATCHDOG — Liquidity checks, price guards
 *   API      — Dashboard HTTP requests to control endpoints
 *   ENGINE   — Polling start/stop, config changes
 *   LEDGER   — Balance changes, position updates
 *   ERROR    — Any caught errors
 */

type LogCategory =
  | 'BOOT' | 'SHUTDOWN' | 'CRASH'
  | 'TRADE' | 'CLOSE' | 'LIFECYCLE'
  | 'WATCHDOG' | 'API' | 'ENGINE'
  | 'LEDGER' | 'ERROR' | 'SYSTEM';

class FileLogger {
  private static instance: FileLogger;
  private logDir: string;
  private currentDate: string = '';
  private stream: fs.WriteStream | null = null;
  private sessionId: string;

  private constructor() {
    this.logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    // Unique session ID to correlate logs across restarts
    this.sessionId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    this.rotateIfNeeded();
  }

  public static getInstance(): FileLogger {
    if (!FileLogger.instance) {
      FileLogger.instance = new FileLogger();
    }
    return FileLogger.instance;
  }

  private getDateStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private getTimestamp(): string {
    return new Date().toISOString();
  }

  private rotateIfNeeded(): void {
    const today = this.getDateStr();
    if (today !== this.currentDate) {
      if (this.stream) {
        this.stream.end();
      }
      this.currentDate = today;
      const filePath = path.join(this.logDir, `bot_${today}.txt`);
      this.stream = fs.createWriteStream(filePath, { flags: 'a' }); // append mode
    }
  }

  /**
   * Core log method. Writes a single line to the daily .txt file.
   */
  public log(category: LogCategory, message: string, data?: Record<string, any>): void {
    this.rotateIfNeeded();
    const ts = this.getTimestamp();
    let line = `[${ts}] [${category}] [sid:${this.sessionId}] ${message}`;
    if (data && Object.keys(data).length > 0) {
      line += ` | ${JSON.stringify(data)}`;
    }
    line += '\n';

    if (this.stream) {
      this.stream.write(line);
    }

    // Also write synchronously for crash-safety on critical events
    if (category === 'CRASH' || category === 'SHUTDOWN') {
      try {
        const filePath = path.join(this.logDir, `bot_${this.currentDate}.txt`);
        fs.appendFileSync(filePath, line);
      } catch (_) { /* last resort, ignore */ }
    }
  }

  // ===== Convenience methods =====

  public boot(message: string, data?: Record<string, any>): void {
    this.log('BOOT', message, data);
  }

  public shutdown(message: string, data?: Record<string, any>): void {
    this.log('SHUTDOWN', message, data);
  }

  public crash(message: string, data?: Record<string, any>): void {
    this.log('CRASH', message, data);
  }

  public trade(message: string, data?: Record<string, any>): void {
    this.log('TRADE', message, data);
  }

  public close(message: string, data?: Record<string, any>): void {
    this.log('CLOSE', message, data);
  }

  public lifecycle(message: string, data?: Record<string, any>): void {
    this.log('LIFECYCLE', message, data);
  }

  public watchdog(message: string, data?: Record<string, any>): void {
    this.log('WATCHDOG', message, data);
  }

  public api(message: string, data?: Record<string, any>): void {
    this.log('API', message, data);
  }

  public engine(message: string, data?: Record<string, any>): void {
    this.log('ENGINE', message, data);
  }

  public ledger(message: string, data?: Record<string, any>): void {
    this.log('LEDGER', message, data);
  }

  public error(message: string, data?: Record<string, any>): void {
    this.log('ERROR', message, data);
  }

  /**
   * Flush and close the stream. Call before process.exit().
   */
  public flush(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

export default FileLogger;
