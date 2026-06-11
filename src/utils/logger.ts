import pino from 'pino';
import path from 'path';
import fs from 'fs';

// Logger de console (pretty) — mantém o comportamento já usado em todo o app.
const consoleLogger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  }
});

// ---------------------------------------------------------------------------
// Log em arquivo (NDJSON) — consumido pelo GET /api/logs da Central.
// Grava uma linha JSON por evento em logs/app-AAAA-MM-DD.log, com rotação
// diária. Escrita síncrona e blindada: falha de log nunca quebra o request.
// ---------------------------------------------------------------------------

export const LOGS_DIR = path.join(process.cwd(), 'logs');
try {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch (e) {
  consoleLogger.error(e, '[logger] falha ao criar diretório de logs');
}

export type LogLevel = 'info' | 'warn' | 'error';

function fileForDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(LOGS_DIR, `app-${y}-${m}-${day}.log`);
}

// Normaliza os argumentos das duas convenções de chamada usadas no app:
//   logger.info('mensagem', { meta })            → event = 'mensagem'
//   logger.error(errOuObj, 'mensagem')            → event = 'mensagem', detail = err.message
function toRecord(args: any[]): { event: string; meta: Record<string, unknown> } {
  if (typeof args[0] === 'string') {
    const meta = (args[1] && typeof args[1] === 'object') ? { ...args[1] } : {};
    return { event: args[0], meta };
  }

  const first = args[0];
  const event = typeof args[1] === 'string' ? args[1] : 'log';
  if (first instanceof Error) {
    return { event, meta: { detail: first.message, stack: first.stack } };
  }
  if (first && typeof first === 'object') {
    return { event, meta: { ...first } };
  }
  return { event, meta: first !== undefined ? { detail: String(first) } : {} };
}

function writeFile(level: LogLevel, args: any[]) {
  try {
    const { event, meta } = toRecord(args);
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta }) + '\n';
    fs.appendFileSync(fileForDate(), line, 'utf8');
  } catch (e) {
    consoleLogger.error(e, '[logger] falha ao escrever no arquivo de log');
  }
}

export const logger = {
  info: (...args: any[]) => {
    (consoleLogger.info as any)(...args);
    writeFile('info', args);
  },
  warn: (...args: any[]) => {
    (consoleLogger.warn as any)(...args);
    writeFile('warn', args);
  },
  error: (...args: any[]) => {
    (consoleLogger.error as any)(...args);
    writeFile('error', args);
  },
  debug: (...args: any[]) => {
    (consoleLogger.debug as any)(...args);
  },
};

// ---------------------------------------------------------------------------
// Leitura usada pelo GET /api/logs.
// ---------------------------------------------------------------------------
export function readLogs(opts: {
  level?: string | null;
  date?: string | null;
  since?: string | null;
  limit?: number;
}): any[] {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const file = opts.date && DATE_RE.test(opts.date)
    ? path.join(LOGS_DIR, `app-${opts.date}.log`)
    : fileForDate();

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const out: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (opts.level && obj.level !== opts.level) continue;
      if (opts.since && obj.ts && obj.ts < opts.since) continue;
      out.push(obj);
    } catch {
      /* tolera linha malformada */
    }
  }
  return out.slice(-(opts.limit ?? 200)).reverse(); // mais recentes primeiro
}
