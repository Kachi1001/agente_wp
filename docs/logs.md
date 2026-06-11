# Logs na Central Tecnika — guia de integração para apps

> **Para quem está lendo isto em outro repositório, sem contexto da Central:**
> A Central (`http://10.0.0.139:4000`) é o portal/dashboard interno da Tecnika.
> Um admin logado na Central pode **ler os logs de qualquer app registrado**, sem
> precisar de SSH na máquina do app. A Central **não armazena** logs: ela busca ao
> vivo no seu app, no momento em que o admin abre a tela, e repassa a resposta.
> Para isso o seu app precisa **expor um endpoint `GET /api/logs`** e gravar seus
> logs em arquivo. Este documento descreve tudo o que o app precisa fazer.

---

## 1. Como funciona, em uma imagem

```
┌──────────────────────── Central (10.0.0.139:4000) ─────────────────────────┐
│  Admin logado (cookie portal_token)                                         │
│   GET /api/admin/apps/{id}/logs?level=&limit=                               │
│        │  a Central encaminha o JWT do admin para o seu app:                │
│        ▼                                                                    │
└────────┬────────────────────────────────────────────────────────────────-─┘
         │  GET https://SEU-APP/api/logs
         │     Authorization: Bearer <JWT do admin>
         ▼
┌──────────────────────────────── SEU APP ───────────────────────────────-───┐
│  GET /api/logs                                                              │
│     1. lê o Bearer                                                          │
│     2. valida perguntando para a Central:                                   │
│          GET http://10.0.0.139:4000/api/v1/auth/verify                      │
│             Authorization: Bearer <JWT>                                      │
│          → { valid: true, user: { role: "admin", ... }, allowedApps: [...] }│
│     3. autoriza só se valid === true && user.role === "admin"               │
│     4. lê o próprio arquivo de log e devolve:                               │
│          { "count": 42, "logs": [ { ts, level, event, ... }, ... ] }        │
└──────────────────────────────────────────────────────────────────────────-┘
```

A Central repassa a resposta do seu app adicionando `appId` e `appName`:
`{ "appId": 1, "appName": "Sacola", "count": 42, "logs": [...] }`.

---

## 2. O endpoint que o seu app DEVE expor

### `GET /api/logs`

**Query params** (a Central repassa quando o admin filtra; todos opcionais):

| Param   | Significado                                  |
|---------|----------------------------------------------|
| `level` | filtrar por nível: `info` \| `warn` \| `error` |
| `limit` | máximo de linhas a devolver (default sugerido: 200, teto 1000) |
| `since` | data/hora ISO — só logs a partir dela        |
| `date`  | `AAAA-MM-DD` — logs daquele dia              |

**Passos obrigatórios:**

1. Ler o header `Authorization: Bearer <token>`. Sem token → **401**.
2. Validar o token chamando a Central (mesmo verify usado para SSO/widgets):
   ```
   GET http://10.0.0.139:4000/api/v1/auth/verify
   Authorization: Bearer <token>
   ```
   Resposta: `{ version: 1, valid: boolean, user: {...}, allowedApps: [...] }`.
3. Autorizar **somente** se `valid === true && user.role === "admin"`. Caso
   contrário → **403**. (Logs são sensíveis: só admin da Central pode ler.)
4. Ler o próprio arquivo de log, aplicar `level`/`limit`/`since`/`date`, e responder
   **JSON**:
   ```json
   {
     "count": 42,
     "logs": [
       { "ts": "2026-06-01T13:45:02.123Z", "level": "error", "event": "db_timeout", "detail": "..." },
       { "ts": "2026-06-01T13:44:10.001Z", "level": "info",  "event": "login_ok", "userId": 7 }
     ]
   }
   ```
   `logs` deve vir **do mais recente para o mais antigo**.

> Use uma var de ambiente no seu app (`CENTRAL_URL`, default `http://10.0.0.139:4000`)
> para montar a URL do verify — não chumbe o IP no código.

### Exemplo de implementação (Next.js, `app/api/logs/route.ts`)

```ts
import { NextRequest, NextResponse } from 'next/server';
import { readLogs } from '@/lib/logger';

export const runtime = 'nodejs';

const CENTRAL_URL = process.env.CENTRAL_URL || 'http://10.0.0.139:4000';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.split(' ')[1];
  if (!token) return NextResponse.json({ error: 'Sem token' }, { status: 401 });

  // valida o JWT de volta na Central
  let verify: any;
  try {
    const r = await fetch(`${CENTRAL_URL}/api/v1/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    verify = await r.json();
  } catch {
    return NextResponse.json({ error: 'Falha ao validar token' }, { status: 502 });
  }
  if (!verify?.valid || verify.user?.role !== 'admin') {
    return NextResponse.json({ error: 'Acesso negado' }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const logs = readLogs({
    level: sp.get('level'),
    date: sp.get('date'),
    since: sp.get('since'),
    limit: Math.min(Number(sp.get('limit')) || 200, 1000),
  });
  return NextResponse.json({ count: logs.length, logs });
}
```

---

## 3. Logger de referência (grava o arquivo de log)

Copie para `lib/logger.ts` no seu app. Grava **NDJSON** (uma linha JSON por evento)
em `data/logs/app-AAAA-MM-DD.log`, com rotação diária. Escrita síncrona e blindada:
**uma falha de log nunca quebra o request**.

```ts
import 'server-only';
import path from 'path';
import fs from 'fs';

const LOGS_DIR = path.join(process.cwd(), 'data', 'logs');
try { if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true }); }
catch (e) { console.error('[logger] mkdir falhou', e); }

export type LogLevel = 'info' | 'warn' | 'error';

function fileForDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(LOGS_DIR, `app-${y}-${m}-${day}.log`);
}

function write(level: LogLevel, event: string, meta?: Record<string, unknown>) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta }) + '\n';
    fs.appendFileSync(fileForDate(), line, 'utf8');
  } catch (e) {
    console.error('[logger] falha ao escrever', e, { level, event });
  }
}

export const log = {
  info:  (event: string, meta?: Record<string, unknown>) => write('info', event, meta),
  warn:  (event: string, meta?: Record<string, unknown>) => write('warn', event, meta),
  error: (event: string, meta?: Record<string, unknown>) => write('error', event, meta),
};

// Leitura usada pelo GET /api/logs.
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
  return out.slice(-(opts.limit ?? 200)).reverse(); // mais recentes primeiro
}
```

Uso no app:

```ts
import { log } from '@/lib/logger';

log.info('login_ok', { userId: user.id });
log.error('db_timeout', { detail: e.message });
```

> O `data/logs/` deve estar no `.gitignore` do app (não versionar logs).

---

## 4. Segurança

O seu app recebe um JWT de **admin** válido, encaminhado pela Central. Isso não
amplia a superfície de confiança: o seu app **já** recebe JWTs de usuário via SSO
e via widgets, e valida todos no mesmo `/api/v1/auth/verify`. A regra extra aqui é
só liberar `/api/logs` quando `user.role === "admin"`.
