import { ChildProcess, fork } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger, appendMainLog } from '../utils/logger';
import { appendSessionLog } from '../utils/sessionLog';
import { config } from '../config';
import {
  ISessionManager,
  AdminSessionRow,
  SessionInfo,
  SessionState,
  MediaType,
  SendMessageResult,
} from './types';
import {
  ChildToParent,
  ParentToChild,
  RpcMethod,
  IPC_PROTOCOL_VERSION,
} from './ipcProtocol';

// Lazy requires para evitar ciclo de importação no load-time
// (SocketService/NotifyService importam o sessionManager, que é este módulo).
function notifyService(): any { return require('./NotifyService').NotifyService; }
function socketSvc(): any { return require('./SocketService').socketService; }

interface PendingRpc {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

interface SessionRecord {
  child: ChildProcess | null;
  epoch: number;                 // ++ a cada spawn; ignora eventos de filho obsoleto
  status: SessionState;          // O ESPELHO — alimenta os getters síncronos
  qrCode: string | null;
  info: SessionInfo | null;
  pid: number | null;
  restarts: number;              // crashes consecutivos (entrada do backoff)
  lastError: string | null;
  startedAt: number;             // epoch ms do último (re)spawn
  pending: Map<number, PendingRpc>;
  nextRpcId: number;
  desired: 'RUNNING' | 'STOPPED';// objetivo declarado; só respawna se RUNNING
  intentional: boolean;          // filho atual sendo morto de propósito (restart manual)
  parked: boolean;               // circuit breaker disparou (parou de respawnar)
  respawnTimer: NodeJS.Timeout | null;
  healthyTimer: NodeJS.Timeout | null;
  pingTimer: NodeJS.Timeout | null;
  bootTimer: NodeJS.Timeout | null;   // deadline STARTING → QR_READY/CONNECTED
  pingId: number;
  awaitingPong: boolean;
  missedPongs: number;
}

// Timeout por método (ms). getContacts pode ser lento em agendas enormes
// (protocolTimeout do puppeteer é 600s).
const RPC_TIMEOUT_MS: Record<RpcMethod, number> = {
  sendMessage: 60000,
  getMessages: 90000,
  editMessage: 45000,
  deleteMessage: 45000,
  forwardMessage: 45000,
  reactToMessage: 30000,
  markAsRead: 20000,
  checkNumber: 30000,
  getContacts: 600000,
  searchContacts: 600000,
  getGroups: 120000,
  getGroupInfo: 60000,
  getGroupMembers: 90000,
  getSessionInfo: 15000,
};

/**
 * Supervisor — substitui o antigo SessionManager in-process. Mantém UM processo
 * filho (sessionWorker) por sessão, faz proxy das operações via IPC RPC e espelha
 * o status localmente para que os getters síncronos continuem síncronos.
 *
 * O loop de "browser is already running" é estruturalmente impossível aqui: um
 * crash do Chromium mata só o filho; o Supervisor respawna um PROCESSO NOVO com
 * locks já limpos e backoff exponencial.
 */
export class Supervisor implements ISessionManager {
  private sessions: Map<string, SessionRecord> = new Map();
  private authFolder: string = path.join(process.cwd(), 'auth_keys');

  private readonly BACKOFF_MIN_MS = 5000;
  private readonly BACKOFF_MAX_MS = 60000;
  private readonly HEALTHY_RESET_MS = 120000;   // CONNECTED por 2min → zera restarts
  private readonly PING_INTERVAL_MS = 30000;
  private readonly PONG_GRACE = 2;              // pongs perdidos antes de matar
  private readonly RESTART_STORM_MAX = 10;      // crashes seguidos → estaciona
  private readonly KILL_GRACE_MS = 8000;        // SIGTERM → SIGKILL
  private readonly BOOT_DEADLINE_MS = 120000;   // travado em STARTING → mata e respawna

  constructor() {
    if (!fs.existsSync(this.authFolder)) fs.mkdirSync(this.authFolder, { recursive: true });
    this.installProcessHooks();
  }

  private delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

  // ── Resolução do entrypoint do worker (dev TS vs prod JS compilado) ─────────
  private workerEntry(): { modulePath: string; execArgv: string[] } {
    // Em prod, __filename = dist/services/Supervisor.js → fork do .js irmão.
    // Em dev (ts-node-dev), __filename termina em .ts → registra ts-node no filho.
    if (__filename.endsWith('.ts')) {
      return {
        modulePath: path.join(__dirname, 'sessionWorker.ts'),
        execArgv: ['-r', 'ts-node/register/transpile-only'],
      };
    }
    return { modulePath: path.join(__dirname, 'sessionWorker.js'), execArgv: [] };
  }

  private clearSingletonLocks(sessionId: string): void {
    const dir = path.join(this.authFolder, `session-${sessionId}`);
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* ignore */ }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GETTERS SÍNCRONOS (espelho) — nunca retornam Promise
  // ══════════════════════════════════════════════════════════════════════════
  getSessionStatus(sessionId: string): { exists: boolean; status: string; qrCode?: string | null } {
    const r = this.sessions.get(sessionId);
    if (!r) return { exists: false, status: 'NOT_FOUND' };
    return { exists: true, status: r.status, qrCode: r.qrCode };
  }

  getAllSessions(): Array<{ id: string; status: string; qrCode: string | null }> {
    const out: Array<{ id: string; status: string; qrCode: string | null }> = [];
    this.sessions.forEach((r, id) => out.push({ id, status: r.status, qrCode: r.qrCode }));
    return out;
  }

  getSessionInfo(sessionId: string): SessionInfo {
    const r = this.sessions.get(sessionId);
    if (!r || r.status !== 'CONNECTED') throw new Error('Session not connected');
    if (!r.info) throw new Error('Session info not available yet');
    return r.info;
  }

  triggerReboot(sessionId: string): void {
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error('Session not found');
    logger.warn(`[${sessionId}] Restart manual via API.`);
    r.parked = false;
    r.restarts = 0;
    r.desired = 'RUNNING';
    if (r.child) {
      r.intentional = true;     // exit handler fará respawn limpo
      this.killChild(r, 'manual restart via API');
    } else {
      // Sem filho vivo (estacionado / nunca subiu) → sobe agora.
      this.spawnChild(sessionId);
    }
  }

  getAdminSnapshot(): AdminSessionRow[] {
    const rows: AdminSessionRow[] = [];
    this.sessions.forEach((r, id) => {
      rows.push({
        id,
        status: r.status,
        qrCode: r.qrCode,
        pid: r.pid,
        uptimeMs: r.child && r.status !== 'DISCONNECTED' ? Date.now() - r.startedAt : null,
        restarts: r.restarts,
        lastError: r.lastError,
        parked: r.parked,
        info: r.info,
      });
    });
    return rows;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ══════════════════════════════════════════════════════════════════════════
  async startSession(sessionId: string): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // Já existe filho vivo ou subindo → no-op (idempotente, evita double-fork).
      if (existing.child || existing.respawnTimer) {
        if (existing.parked) {
          logger.info(`[${sessionId}] startSession: reativando sessão estacionada.`);
          existing.parked = false;
          existing.restarts = 0;
          existing.desired = 'RUNNING';
          if (!existing.child) this.spawnChild(sessionId);
        } else {
          logger.info(`[${sessionId}] startSession: já ativo — ignorando.`);
        }
        return;
      }
      existing.parked = false;
      existing.restarts = 0;
      existing.desired = 'RUNNING';
    }
    this.spawnChild(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const r = this.sessions.get(sessionId);
    if (r) {
      logger.info(`[${sessionId}] Encerrando sessao...`);
      r.desired = 'STOPPED';
      r.intentional = true;
      this.clearTimers(r);
      this.rejectAllPending(r, 'session deleted');
      if (r.child) {
        // Pede logout gracioso (sem SIGTERM concorrente) e dá tempo ao worker de
        // deslogar + matar o browser; SIGKILL só como último recurso.
        this.sendToChild(r, { kind: 'shutdown', mode: 'logout' });
        await this.awaitExit(r, this.KILL_GRACE_MS + 4000);
      }
      this.sessions.delete(sessionId);
    }

    const sessionPath = path.join(this.authFolder, `session-${sessionId}`);
    if (fs.existsSync(sessionPath)) {
      try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        logger.info(`[${sessionId}] Dados de auth deletados.`);
      } catch (e) {
        logger.error(e as Error, `[${sessionId}] Erro ao deletar dados de auth.`);
      }
    }
    this.broadcastAdmin();
  }

  async loadSavedSessions(): Promise<void> {
    if (!fs.existsSync(this.authFolder)) return;
    const directories = fs.readdirSync(this.authFolder, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('session-'))
      .map(d => d.name.replace('session-', ''));

    logger.info(`Sessões salvas encontradas: ${directories.length} → [${directories.join(', ')}]`);
    for (const sessionId of directories) {
      await this.startSession(sessionId);
      await this.delay(2000);   // mantém o stagger do monólito (evita pico de N Chromiums)
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SPAWN / EXIT / RESPAWN
  // ══════════════════════════════════════════════════════════════════════════
  private spawnChild(sessionId: string): void {
    let r = this.sessions.get(sessionId);
    if (!r) {
      r = {
        child: null, epoch: 0, status: 'STARTING', qrCode: null, info: null, pid: null,
        restarts: 0, lastError: null, startedAt: Date.now(), pending: new Map(), nextRpcId: 0,
        desired: 'RUNNING', intentional: false, parked: false,
        respawnTimer: null, healthyTimer: null, pingTimer: null, bootTimer: null, pingId: 0,
        awaitingPong: false, missedPongs: 0,
      };
      this.sessions.set(sessionId, r);
    }
    if (r.child) { logger.warn(`[${sessionId}] spawnChild ignorado — filho ainda vivo.`); return; }

    // Limpa locks órfãos antes de subir (belt-and-suspenders; o worker também limpa).
    this.clearSingletonLocks(sessionId);

    if (r.respawnTimer) { clearTimeout(r.respawnTimer); r.respawnTimer = null; }
    r.intentional = false;
    r.awaitingPong = false;
    r.missedPongs = 0;
    r.startedAt = Date.now();
    this.setStatus(sessionId, 'STARTING');

    const epoch = ++r.epoch;
    const { modulePath, execArgv } = this.workerEntry();

    this.slog(sessionId, 'info', `Starting session: ${sessionId} (fork ${path.basename(modulePath)}, epoch ${epoch})`);

    let child: ChildProcess;
    try {
      child = fork(modulePath, [], {
        cwd: process.cwd(),
        env: { ...process.env, WW_SESSION_ID: sessionId, WW_AUTH_FOLDER: this.authFolder, WW_BASE_URL: config.baseUrl },
        execArgv,
      });
    } catch (err: any) {
      logger.error(`[${sessionId}] fork falhou: ${err?.message}`);
      r.child = null;
      this.setStatus(sessionId, 'DISCONNECTED', `fork error: ${err?.message}`);
      this.scheduleRespawn(sessionId, `fork error: ${err?.message}`);
      return;
    }

    r.child = child;
    r.pid = child.pid ?? null;

    child.on('message', (m: ChildToParent) => {
      const cur = this.sessions.get(sessionId);
      if (!cur || cur.epoch !== epoch) return;   // mensagem de filho obsoleto
      this.onChildMessage(sessionId, m);
    });
    child.on('error', (err) => {
      logger.error(`[${sessionId}] erro no processo filho: ${err?.message}`);
    });
    child.on('exit', (code, signal) => {
      const cur = this.sessions.get(sessionId);
      if (!cur || cur.epoch !== epoch) return;   // exit de filho obsoleto
      this.onChildExit(sessionId, code, signal);
    });

    this.armPing(sessionId);
    this.armBootDeadline(sessionId);
    this.broadcastAdmin();
  }

  /**
   * Deadline de boot: se a sessão não sair de STARTING (para QR_READY ou
   * CONNECTED) dentro do prazo, o initialize() provavelmente travou — mata o
   * filho para o respawn entrar. Cobre o buraco em que o ping watchdog (só ativo
   * em CONNECTED) e o healthcheck do filho (só após 'ready') não atuam.
   * NÃO dispara em QR_READY: ficar aguardando leitura do QR é estado válido.
   */
  private armBootDeadline(sessionId: string): void {
    const r = this.sessions.get(sessionId);
    if (!r) return;
    if (r.bootTimer) clearTimeout(r.bootTimer);
    r.bootTimer = setTimeout(() => {
      const cur = this.sessions.get(sessionId);
      if (!cur || !cur.child) return;
      if (cur.status === 'STARTING') {
        logger.error(`[${sessionId}] boot deadline: travado em STARTING por ${this.BOOT_DEADLINE_MS}ms — matando filho.`);
        this.killChild(cur, 'boot deadline timeout');
      }
    }, this.BOOT_DEADLINE_MS);
  }

  private onChildExit(sessionId: string, code: number | null, signal: string | null): void {
    const r = this.sessions.get(sessionId);
    if (!r) return;

    const reason = `worker exited (code=${code}, signal=${signal})`;
    this.slog(sessionId, 'warn', `[${sessionId}] ${reason}`);

    r.child = null;
    r.pid = null;
    this.clearTimers(r);
    this.rejectAllPending(r, 'worker exited');

    // Delete intencional → espelho DISCONNECTED SILENCIOSO (o legacy deleteSession
    // não emitia 'session.disconnected'; emiti-lo aqui mudaria o comportamento do
    // front a cada exclusão de sessão).
    if (r.desired === 'STOPPED') {
      r.status = 'DISCONNECTED';
      this.broadcastAdmin();
      return;
    }

    // Demais casos (crash, restart manual): transição visível → emite disconnect.
    if (r.status !== 'DISCONNECTED') this.setStatus(sessionId, 'DISCONNECTED', r.lastError ?? reason);

    if (r.parked) { this.broadcastAdmin(); return; }

    if (r.intentional) {
      // Restart manual: respawn rápido, sem penalizar o backoff.
      r.intentional = false;
      r.respawnTimer = setTimeout(() => { r.respawnTimer = null; this.spawnChild(sessionId); }, 1000);
      this.broadcastAdmin();
      return;
    }

    // Crash genuíno → backoff + circuit breaker.
    r.restarts += 1;
    if (r.restarts >= this.RESTART_STORM_MAX) {
      r.parked = true;
      r.lastError = `estacionada após ${r.restarts} crashes consecutivos`;
      this.slog(sessionId, 'error', `[${sessionId}] Circuit breaker: ${r.lastError}. Respawn suspenso até restart manual.`);
      this.broadcastAdmin();
      return;
    }
    this.scheduleRespawn(sessionId, reason);
  }

  private scheduleRespawn(sessionId: string, reason: string): void {
    const r = this.sessions.get(sessionId);
    if (!r || r.desired !== 'RUNNING' || r.parked) return;
    const backoff = Math.min(this.BACKOFF_MAX_MS, this.BACKOFF_MIN_MS * 2 ** Math.min(r.restarts - 1, 4));
    this.slog(sessionId, 'warn', `[${sessionId}] Respawn (tentativa #${r.restarts}) em ${backoff}ms. Motivo: ${reason}.`);
    if (r.respawnTimer) clearTimeout(r.respawnTimer);
    r.respawnTimer = setTimeout(() => { r.respawnTimer = null; this.spawnChild(sessionId); }, backoff);
    this.broadcastAdmin();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MENSAGENS DO FILHO
  // ══════════════════════════════════════════════════════════════════════════
  private onChildMessage(sessionId: string, m: ChildToParent): void {
    const r = this.sessions.get(sessionId);
    if (!r) return;

    switch (m.kind) {
      case 'hello':
        if (m.protocol !== IPC_PROTOCOL_VERSION) {
          logger.error(`[${sessionId}] versão de protocolo IPC incompatível (filho=${m.protocol}, pai=${IPC_PROTOCOL_VERSION}) — matando.`);
          this.killChild(r, 'protocol mismatch');
        }
        return;

      case 'state': {
        if (m.qrCode !== undefined) r.qrCode = m.qrCode;
        if (m.info !== undefined) r.info = m.info;
        // Saiu de STARTING: cancela o deadline de boot.
        if (m.status === 'QR_READY' || m.status === 'CONNECTED') {
          if (r.bootTimer) { clearTimeout(r.bootTimer); r.bootTimer = null; }
        }
        // Chegar a QR_READY já prova que o boot foi saudável (Chromium + WW
        // carregaram) → zera o backoff para que pareamento lento/flaky não
        // estacione a sessão por engano no circuit breaker.
        if (m.status === 'QR_READY') r.restarts = 0;
        if (m.status === 'CONNECTED') {
          r.qrCode = null;
          this.armHealthyReset(sessionId);
        }
        this.setStatus(sessionId, m.status, m.reason);
        return;
      }

      case 'event':
        this.relayEvent(sessionId, m.eventType, m.data);
        return;

      case 'rpc:res': {
        const p = r.pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        r.pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error?.message || 'RPC error'));
        return;
      }

      case 'pong':
        r.awaitingPong = false;
        r.missedPongs = 0;
        return;

      case 'log':
        // O worker já gravou no arquivo da sessão e imprimiu no stdout herdado.
        // Aqui só replicamos no log GLOBAL (sem reimprimir) e transmitimos ao vivo.
        appendMainLog(m.level, m.event, m.meta, m.ts);
        try { socketSvc().broadcastAdminLog(sessionId, { ts: m.ts ?? new Date().toISOString(), level: m.level, event: m.event, meta: m.meta }); } catch {}
        return;

      case 'fatal':
        r.lastError = m.reason;
        // O exit do processo é a fonte autoritativa do respawn; aqui só registramos.
        return;
    }
  }

  private relayEvent(sessionId: string, eventType: string, data: any): void {
    const N = notifyService();
    switch (eventType) {
      case 'message.received': N.notifyMessage(sessionId, data); break;
      case 'message.edit': N.notifyMessageEdit(sessionId, data); break;
      case 'message.delete': N.notifyMessageDelete(sessionId, data); break;
      case 'message.reaction': N.notifyMessageReaction(sessionId, data); break;
      case 'message.ack': N.notifyMessageAck(sessionId, data); break;
      case 'session.connected': N.notifyStatus(sessionId, 'session.connected', data); break;
      case 'session.authenticated': N.notifyStatus(sessionId, 'session.authenticated', data); break;
    }
  }

  // Atualiza o espelho e dispara notify de desconexão na transição.
  private setStatus(sessionId: string, status: SessionState, reason?: string): void {
    const r = this.sessions.get(sessionId);
    if (!r) return;
    const prev = r.status;
    r.status = status;
    if (reason) r.lastError = reason;

    if (status === 'DISCONNECTED' && prev !== 'DISCONNECTED') {
      try {
        notifyService().notifyStatus(sessionId, 'session.disconnected', {
          status: 'DISCONNECTED',
          reason: reason ?? r.lastError ?? 'disconnected',
          message: 'WhatsApp desconectado ou inacessível',
        });
      } catch (err: any) {
        logger.warn(`[${sessionId}] Falha ao notificar desconexão: ${err?.message}`);
      }
    }
    this.broadcastAdmin();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WATCHDOG (pai → filho) + reset de backoff
  // ══════════════════════════════════════════════════════════════════════════
  private armPing(sessionId: string): void {
    const r = this.sessions.get(sessionId);
    if (!r) return;
    if (r.pingTimer) clearInterval(r.pingTimer);
    r.pingTimer = setInterval(() => {
      const cur = this.sessions.get(sessionId);
      if (!cur || !cur.child || cur.status !== 'CONNECTED') return;
      if (cur.awaitingPong) {
        cur.missedPongs += 1;
        if (cur.missedPongs >= this.PONG_GRACE) {
          logger.error(`[${sessionId}] watchdog: ${cur.missedPongs} pongs perdidos — matando filho.`);
          this.killChild(cur, 'ping watchdog timeout');
          return;
        }
      }
      cur.awaitingPong = true;
      this.sendToChild(cur, { kind: 'ping', id: ++cur.pingId });
    }, this.PING_INTERVAL_MS);
  }

  private armHealthyReset(sessionId: string): void {
    const r = this.sessions.get(sessionId);
    if (!r) return;
    if (r.healthyTimer) clearTimeout(r.healthyTimer);
    r.healthyTimer = setTimeout(() => {
      const cur = this.sessions.get(sessionId);
      if (cur && cur.status === 'CONNECTED') {
        cur.restarts = 0;   // saudável o suficiente → zera o backoff
        logger.info(`[${sessionId}] Sessão estável por ${this.HEALTHY_RESET_MS}ms — backoff zerado.`);
      }
    }, this.HEALTHY_RESET_MS);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // KILL / TIMERS / PENDING
  // ══════════════════════════════════════════════════════════════════════════
  private killChild(r: SessionRecord, reason: string): void {
    const child = r.child;
    if (!child) return;
    logger.warn(`killChild (pid ${r.pid}): ${reason}`);
    // SIGTERM → o worker faz killBrowser + exit. SIGKILL no MESMO processo
    // capturado após grace, caso trave (o respawn pode já ter trocado r.child).
    try { child.kill('SIGTERM'); } catch {}
    const killTimer = setTimeout(() => {
      try { if (!child.killed) child.kill('SIGKILL'); } catch {}
    }, this.KILL_GRACE_MS);
    child.once('exit', () => clearTimeout(killTimer));
  }

  /** Aguarda o 'exit' do filho até graceMs; SIGKILL como último recurso. */
  private awaitExit(r: SessionRecord, graceMs: number): Promise<void> {
    const child = r.child;
    if (!child) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      child.once('exit', finish);
      setTimeout(() => { try { if (!done && !child.killed) child.kill('SIGKILL'); } catch {} finish(); }, graceMs);
    });
  }

  private clearTimers(r: SessionRecord): void {
    if (r.pingTimer) { clearInterval(r.pingTimer); r.pingTimer = null; }
    if (r.healthyTimer) { clearTimeout(r.healthyTimer); r.healthyTimer = null; }
    if (r.bootTimer) { clearTimeout(r.bootTimer); r.bootTimer = null; }
    // respawnTimer NÃO é limpo aqui — ele agenda o próximo spawn.
  }

  private rejectAllPending(r: SessionRecord, reason: string): void {
    for (const [id, p] of r.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Sessão em recuperação automática (${reason})`));
      r.pending.delete(id);
    }
  }

  private sendToChild(r: SessionRecord, msg: ParentToChild): boolean {
    try {
      if (r.child && r.child.connected) return r.child.send(msg);
    } catch (err: any) {
      logger.warn(`Falha ao enviar IPC ao filho: ${err?.message}`);
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RPC (operações por sessão) — assinaturas idênticas ao SessionManager
  // ══════════════════════════════════════════════════════════════════════════
  private assertConnected(sessionId: string): void {
    const r = this.sessions.get(sessionId);
    if (!r || r.status !== 'CONNECTED') throw new Error('Session not connected');
  }

  private callRpc<T = any>(sessionId: string, method: RpcMethod, args: any[]): Promise<T> {
    const r = this.sessions.get(sessionId);
    if (!r || !r.child || r.status !== 'CONNECTED') {
      return Promise.reject(new Error('Session not connected'));
    }
    const id = ++r.nextRpcId;
    const timeoutMs = RPC_TIMEOUT_MS[method];
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        r.pending.delete(id);
        reject(new Error(`RPC ${method} expirou após ${timeoutMs}ms`));
      }, timeoutMs);
      r.pending.set(id, { resolve, reject, timer, method });
      const ok = this.sendToChild(r, { kind: 'rpc', id, method, args });
      if (!ok) {
        clearTimeout(timer);
        r.pending.delete(id);
        reject(new Error('Session not connected'));
      }
    });
  }

  async sendMessage(
    sessionId: string, to: string, text: string,
    mediaType?: MediaType, mediaBuffer?: Buffer, mediaMime?: string, quotedMessageId?: string,
  ): Promise<SendMessageResult> {
    this.assertConnected(sessionId);
    const mediaBase64 = mediaBuffer ? mediaBuffer.toString('base64') : undefined;
    return this.callRpc(sessionId, 'sendMessage', [to, text, mediaType, mediaBase64, mediaMime, quotedMessageId]);
  }
  getMessages(sessionId: string, number: string, limit?: number): Promise<any[]> {
    this.assertConnected(sessionId); return this.callRpc(sessionId, 'getMessages', [number, limit ?? 50]);
  }
  editMessage(sessionId: string, number: string, messageId: string, newText: string): Promise<any> {
    this.assertConnected(sessionId); return this.callRpc(sessionId, 'editMessage', [number, messageId, newText]);
  }
  deleteMessage(sessionId: string, number: string, messageId: string): Promise<any> {
    this.assertConnected(sessionId); return this.callRpc(sessionId, 'deleteMessage', [number, messageId]);
  }
  forwardMessage(sessionId: string, fromNumber: string, messageId: string, toNumber: string): Promise<void> {
    this.assertConnected(sessionId); return this.callRpc(sessionId, 'forwardMessage', [fromNumber, messageId, toNumber]);
  }
  reactToMessage(sessionId: string, number: string, messageId: string, emoji: string): Promise<any> {
    this.assertConnected(sessionId); return this.callRpc(sessionId, 'reactToMessage', [number, messageId, emoji]);
  }
  markAsRead(sessionId: string, chatId: string): Promise<void> {
    this.assertConnected(sessionId); return this.callRpc(sessionId, 'markAsRead', [chatId]);
  }
  checkNumber(sessionId: string, number: string): Promise<any> {
    this.assertConnected(sessionId); return this.callRpc(sessionId, 'checkNumber', [number]);
  }
  getContacts(sessionId: string, opts?: { withProfilePic?: boolean }): Promise<any[]> {
    this.assertConnected(sessionId); return this.callRpc(sessionId, 'getContacts', [opts ?? {}]);
  }
  searchContacts(sessionId: string, query: string, opts?: { withProfilePic?: boolean }): Promise<any[]> {
    this.assertConnected(sessionId); return this.callRpc(sessionId, 'searchContacts', [query, opts ?? {}]);
  }
  getGroups(sessionId: string): Promise<any[]> {
    this.assertConnected(sessionId); return this.callRpc(sessionId, 'getGroups', []);
  }
  getGroupInfo(sessionId: string, groupId: string): Promise<any> {
    this.assertConnected(sessionId); return this.callRpc(sessionId, 'getGroupInfo', [groupId]);
  }
  getGroupMembers(sessionId: string, groupId: string): Promise<any[]> {
    this.assertConnected(sessionId); return this.callRpc(sessionId, 'getGroupMembers', [groupId]);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Painel: broadcast do snapshot a cada mudança do espelho
  // ══════════════════════════════════════════════════════════════════════════
  private broadcastAdmin(): void {
    try { socketSvc().broadcastAdmin(this.getAdminSnapshot()); } catch { /* socket ainda não pronto */ }
  }

  /**
   * Log de evento de LIFECYCLE (originado no pai) que também pertence ao
   * histórico/terminal da sessão: vai para o console+global (via logger), para o
   * arquivo da sessão e para o stream ao vivo do /admin.
   */
  private slog(sessionId: string, level: 'info' | 'warn' | 'error', event: string, meta?: Record<string, unknown>): void {
    (logger as any)[level]?.(event, meta ?? {});
    const ts = new Date().toISOString();
    appendSessionLog(sessionId, { ts, level, event, meta });
    try { socketSvc().broadcastAdminLog(sessionId, { ts, level, event, meta }); } catch {}
  }

  // ── Encerramento do pai (PM2 reload/stop) → derruba todos os filhos ─────────
  private installProcessHooks(): void {
    const term = () => {
      this.sessions.forEach((r) => {
        r.desired = 'STOPPED';
        if (r.child) {
          try { r.child.kill('SIGTERM'); } catch {}
          const c = r.child;
          setTimeout(() => { try { if (!c.killed) c.kill('SIGKILL'); } catch {} }, this.KILL_GRACE_MS);
        }
      });
      // Encerra o pai após o grace para que o PM2 conclua o reload e os filhos
      // sejam reapados (o handler 'exit' abaixo é a rede síncrona final).
      setTimeout(() => process.exit(0), this.KILL_GRACE_MS + 500);
    };
    process.once('SIGTERM', term);
    process.once('SIGINT', term);
    // 'exit' roda SÍNCRONO — setTimeout não dispara aqui. SIGKILL direto.
    process.once('exit', () => {
      this.sessions.forEach((r) => { if (r.child) { try { r.child.kill('SIGKILL'); } catch {} } });
    });
  }
}
