# Isolamento de Sessões + Painel /admin

## O que mudou

Cada sessão WhatsApp agora roda no **próprio processo Node filho** (`child_process.fork`),
com seu próprio Chromium. Um crash/OOM do Chromium mata **apenas aquele filho** — um
**Supervisor** (processo pai) faz respawn com backoff exponencial. O antigo loop de reboot
in-process (`"The browser is already running…"` em cascata) é **estruturalmente impossível**:
todo respawn é um processo novo, com os `SingletonLock` já limpos.

A API pública do serviço **não mudou** — controllers, rotas e Socket.IO continuam idênticos.

### Topologia

```
Processo pai (PM2)
├── Supervisor.ts        ← espelho de status (getters síncronos), fork/respawn,
│                          backoff, watchdog (ping), RPC, relay p/ NotifyService
├── Socket.IO + Express  ← inalterados
└── filhos (1 por sessão)
    └── sessionWorker.ts ← 1 Client whatsapp-web.js + Chromium; eventos via IPC;
                            self-heal: frame morto → process.exit(1) → respawn
```

| Arquivo | Papel |
|---|---|
| `src/services/Supervisor.ts` | Processo pai. Substitui o `sessionManager`. |
| `src/services/sessionWorker.ts` | Entrypoint do filho (1 sessão). |
| `src/services/ipcProtocol.ts` | Tipos das mensagens IPC pai↔filho. |
| `src/services/types.ts` | `ISessionManager` (contrato preservado) + tipos. |
| `src/services/waMedia.ts` | Helpers puros (mídia/fotos) compartilhados. |
| `src/services/SessionManager.ts` | Shim: escolhe Supervisor (padrão) ou Legacy. |
| `src/services/LegacySessionManager.ts` | Monólito antigo, mantido como fallback. |

## Variáveis de ambiente

| Var | Padrão | Efeito |
|---|---|---|
| `WORKER_MODE` | `1` (ligado) | `0` → volta ao monólito in-process (rollback sem redeploy). |
| `CENTRAL_AUTH_URL` | `http://10.0.0.139:4000` | Central SSO — usada no redirect de login e na validação (`/auth/verify`). |
| `APP_ID` | _(vazio)_ | Identificador deste app na Central (ex.: `agente_wp`). Usado no redirect e na checagem de acesso (`apps`). **Defina.** |
| `AUTH_ENABLED` | _(vazio)_ | Inalterado. Quando `true`, as ações `/session/*` exigem JWT — o painel reusa o token SSO. |

## Painel /admin

Acesse **`http://<host>:<porta>/admin`**. Recursos (somente operação):

- Listar sessões com **status ao vivo**, PID, uptime, nº de restarts e último erro.
- **Criar/iniciar**, **reiniciar** (uma sessão isolada) e **parar** (apaga auth).
- **Escanear QR** (modal, atualiza sozinho).
- **📜 Terminal por sessão**: clique em *Logs* numa sessão → histórico + stream ao vivo
  daquela sessão (inclui eventos de lifecycle do Supervisor: spawn/respawn/crash).
- **📡 Apps conectados**: lista os clientes Socket.IO (apps consumidores) conectados,
  com a sessão/sala que cada um acompanha.
- **Cauda de logs globais** com filtro por nível.

Atualização ao vivo via Socket.IO (`admin:sessions`, `admin:log`, `admin:clients`) +
fallback de polling. Sem build: HTML/JS estático em `public/admin/`, servido pelo Express.

### Logs por sessão (separação + histórico)

Cada sessão grava seu próprio NDJSON em **`logs/sessions/<id>/AAAA-MM-DD.log`** — separa o
"terminal" de cada sessão e elimina a escrita concorrente de vários processos no arquivo
único. O log global (`logs/app-*.log`, consumido pela Central) é mantido: o pai replica
nele os logs recebidos dos workers, sem dupla impressão no console do PM2.

| Origem | Vai para |
|---|---|
| Worker (runtime da sessão, mídia, etc.) | `logs/sessions/<id>/` + stream `admin:log` + global |
| Supervisor (spawn/respawn/crash/circuit breaker) | idem (via `slog`) |
| Pai / app geral | `logs/app-*.log` (global) |

Endpoints: `GET /admin/api/logs?session=<id>` (histórico da sessão) · `GET /admin/api/clients`
(apps conectados). Ambos exigem login SSO (papel `admin`).

### Login (SSO da Central — fluxo de redirect)
Segue o runbook oficial da Tecnika — **sem página de login local**:
1. Navegar para `/admin` sem sessão → o backend (`adminAuth`) redireciona o browser
   para `{CENTRAL_AUTH_URL}/login?redirect=<url>&app_id=<APP_ID>&error=no_token`.
2. A Central autentica (aproveitando a sessão/cookie existente) e devolve para
   `/admin?sso_token=<jwt>`.
3. O `adminAuth` captura o `sso_token`, grava no **cookie `sso_token`** (8h), limpa a
   URL e valida o token em `{CENTRAL_AUTH_URL}/auth/verify` (checando acesso ao app
   via `apps`/`allowedApps`).
4. O painel lê o cookie e envia `Authorization: Bearer` em tudo — `/admin/api/*` e as
   ações `/session/*`. Em **401** limpa o cookie e volta ao SSO; **403** → tela de
   "sem permissão".
- Bypass M2M: enviar o `webhookSecret` como `Bearer` (consistente com o `authMiddleware`).
- `GET /admin/api/me` devolve o usuário autenticado (nome no cabeçalho + botão Sair).

## Robustez (relocada e reforçada)

- **SIGKILL do Chromium** via `browser.process()` no shutdown do filho — `close()/destroy()`
  viram no-op quando o CDP já morreu; o SIGKILL é o que de fato evita o zumbi.
- **Limpeza de `SingletonLock/Cookie/Socket`** antes de cada boot (no filho e no pai).
- **Backoff exponencial** 5s→10s→20s→40s→60s; zera ao atingir QR_READY ou após 2min CONNECTED.
- **Circuit breaker**: após 10 crashes seguidos a sessão é **estacionada** (para de respawnar)
  e aparece como tal no painel — reinício manual a destrava.
- **Deadline de boot** (120s): filho travado em STARTING é morto e respawnado.
- **Watchdog de ping** (pai→filho, 30s) + healthcheck do `pupPage` no filho.
- Pendências de RPC são rejeitadas na morte do filho — nenhuma request do Express trava.

## Deploy (PM2)

Nada muda no `ecosystem.config.js`. Recomendado:

```bash
npm run build
pm2 reload ecosystem.config.js --update-env
```

> O Supervisor derruba os filhos no `SIGTERM`/`SIGINT` do pai e encerra após o grace,
> para o PM2 reapar a árvore. Garanta `kill_timeout` do PM2 ≥ 9000ms se quiser logout
> gracioso das sessões no reload.

## Rollback

Sem migração de dados (o layout de `auth_keys/` é o mesmo). Para voltar ao monólito:

```bash
pm2 set agente_wp:WORKER_MODE 0   # ou env WORKER_MODE=0 no ecosystem
pm2 reload agente_wp --update-env
```
