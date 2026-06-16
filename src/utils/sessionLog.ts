import * as fs from 'fs';
import * as path from 'path';

// ──────────────────────────────────────────────────────────────────────────────
// Log POR SESSÃO (NDJSON). Cada sessão tem sua própria árvore de arquivos:
//   logs/sessions/<sessionId>/AAAA-MM-DD.log
//
// Isso separa o "terminal" de cada sessão e dá histórico persistente, sem a
// escrita concorrente de múltiplos processos no arquivo global.
//
// Sem dependência do logger (evita ciclo: logger.ts importa este módulo).
// ──────────────────────────────────────────────────────────────────────────────

export const SESSIONS_LOG_DIR = path.join(process.cwd(), 'logs', 'sessions');

function safe(id: string): string { return id.replace(/[^a-zA-Z0-9_.-]/g, '_'); }

function fileFor(sessionId: string, d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(SESSIONS_LOG_DIR, safe(sessionId), `${y}-${m}-${day}.log`);
}

export interface SessionLogRecord {
  ts: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  meta?: Record<string, unknown>;
}

/** Acrescenta uma linha NDJSON ao log da sessão. Nunca lança. */
export function appendSessionLog(sessionId: string, rec: SessionLogRecord): void {
  try {
    const file = fileFor(sessionId);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: rec.ts, level: rec.level, event: rec.event, ...(rec.meta || {}) }) + '\n';
    fs.appendFileSync(file, line, 'utf8');
  } catch { /* logging nunca quebra o fluxo */ }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Lê o log da sessão (mais recentes primeiro), com filtros opcionais. */
export function readSessionLogs(
  sessionId: string,
  opts: { level?: string | null; date?: string | null; since?: string | null; limit?: number } = {},
): any[] {
  const d = opts.date && DATE_RE.test(opts.date) ? opts.date : undefined;
  const file = d
    ? path.join(SESSIONS_LOG_DIR, safe(sessionId), `${d}.log`)
    : fileFor(sessionId);

  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }

  const out: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (opts.level && obj.level !== opts.level) continue;
      if (opts.since && obj.ts && obj.ts < opts.since) continue;
      out.push(obj);
    } catch { /* tolera linha malformada */ }
  }
  return out.slice(-(opts.limit ?? 200)).reverse();
}

/** IDs de sessão que possuem diretório de log (para o painel). */
export function listSessionsWithLogs(): string[] {
  try {
    if (!fs.existsSync(SESSIONS_LOG_DIR)) return [];
    return fs.readdirSync(SESSIONS_LOG_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return []; }
}
