import { format } from 'date-fns';

const LEVELS = ['INFO', 'WARN', 'ERROR'] as const;
type LogLevel = (typeof LEVELS)[number];

const CONSOLE_MAP: Record<LogLevel, 'info' | 'warn' | 'error'> = {
  INFO:  'info',
  WARN:  'warn',
  ERROR: 'error',
};

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const timestamp = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
  const metaStr   = meta ? ` ${JSON.stringify(meta)}` : '';
  console[CONSOLE_MAP[level]](`[${timestamp}] [${level}] ${message}${metaStr}`);
}

export const logger = {
  info:  (msg: string, meta?: Record<string, unknown>): void => log('INFO', msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>): void => log('WARN', msg, meta),
  error: (msg: string | Error, meta?: Record<string, unknown>): void => {
    const message = msg instanceof Error ? msg.message : String(msg);
    const stack   = msg instanceof Error ? msg.stack   : undefined;
    log('ERROR', message, { ...meta, ...(stack ? { stack } : {}) });
  },
};
