import * as fs from 'fs';
import * as path from 'path';

interface TradeData {
  timestamp: number;
  profileAddress: string;
  marketQuestion: string;
  side: 'YES' | 'NO';
  size: number;
  price: number;
  intent: 'open' | 'close';
}

export default class LogService {
  private static instance: LogService;
  private logsDir: string;

  private constructor() {
    this.logsDir = path.join(process.cwd(), 'logs');
    this.ensureDirectory();
  }

  public static getInstance(): LogService {
    if (!LogService.instance) {
      LogService.instance = new LogService();
    }
    return LogService.instance;
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  private getTradeLogPath(): string {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    return path.join(this.logsDir, `trades_${dateStr}.csv`);
  }

  private ensureTradeLogHeader(): void {
    const logPath = this.getTradeLogPath();
    if (!fs.existsSync(logPath)) {
      const header =
        'timestamp,profileAddress,marketQuestion,side,size,price,intent\n';
      fs.writeFileSync(logPath, header);
    }
  }

  public logTrade(tradeData: TradeData): void {
    this.ensureTradeLogHeader();
    const logPath = this.getTradeLogPath();

    const timestamp = new Date(tradeData.timestamp).toISOString();
    const escapedQuestion = `"${tradeData.marketQuestion.replace(/"/g, '""')}"`;

    const line =
      `${timestamp},${tradeData.profileAddress},${escapedQuestion},${tradeData.side},${tradeData.size},${tradeData.price},${tradeData.intent}\n`;

    fs.appendFileSync(logPath, line);
  }

  // Allow both: logSystem(message) and logSystem(context, message)
  public logSystem(contextOrMessage?: string, message?: string) {
    if (message === undefined) {
      // single-arg usage: logSystem(message)
      const msg = contextOrMessage ?? '';
      console.log(`[SYSTEM] ${msg}`);
    } else {
      // two-arg usage: logSystem(context, message)
      console.log(`[SYSTEM][${contextOrMessage}] ${message}`);
    }
  }

  // Allow both: logError(error) and logError(context, error)
  public logError(contextOrError?: string | Error, error?: unknown) {
    if (error === undefined && contextOrError instanceof Error) {
      console.error(`[ERROR] ${contextOrError.message}`, contextOrError);
    } else if (error === undefined) {
      console.error(`[ERROR] ${String(contextOrError)}`);
    } else {
      console.error(`[ERROR][${String(contextOrError)}]`, error);
    }
  }
}