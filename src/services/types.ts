// ──────────────────────────────────────────────────────────────────────────────
// Tipos de domínio compartilhados entre o Supervisor (pai), o LegacySessionManager
// (fallback) e os controllers. A interface ISessionManager é a GARANTIA de
// fidelidade: ambas as implementações a satisfazem, então qualquer divergência de
// assinatura vira erro de compilação.
// ──────────────────────────────────────────────────────────────────────────────

export type SessionState = 'STARTING' | 'QR_READY' | 'CONNECTED' | 'DISCONNECTED';

export type MediaType = 'image' | 'audio' | 'video' | 'document' | 'ptt';

export interface SessionInfo {
  jid: string | null;
  number: string | null;
  pushname: string | null;
  platform: string | null;
}

export interface SendMessageResult {
  id: string;
  serializedId: string;
  fromMe: boolean;
  to: string;
  text: string;
  timestamp: number;
  /**
   * true quando o envio sofreu dead-frame DEPOIS do dispatch e o resultado foi
   * reconciliado via evento message_create (a mensagem realmente saiu). A sessão
   * é respawnada em seguida, mas o serializedId é real — a plataforma correlaciona
   * normalmente e não marca como "fora da plataforma".
   */
  recovered?: boolean;
}

/** Linha enriquecida exibida no painel /admin. */
export interface AdminSessionRow {
  id: string;
  status: SessionState | 'NOT_FOUND';
  qrCode: string | null;
  /** PID do processo filho (null no modo legado / quando sem filho vivo). */
  pid: number | null;
  /** ms desde o último (re)spawn — null quando não há processo. */
  uptimeMs: number | null;
  /** Reinícios consecutivos (alimenta o backoff). */
  restarts: number;
  /** Último motivo de queda/saída. */
  lastError: string | null;
  /** true quando o circuit breaker estacionou a sessão (parou de respawnar). */
  parked: boolean;
  info: SessionInfo | null;
}

/**
 * Superfície pública preservada do antigo `sessionManager`. Tanto o Supervisor
 * (modo isolado) quanto o LegacySessionManager (fallback) implementam isto, então
 * controllers/rotas/sockets continuam idênticos.
 *
 * Os 4 primeiros métodos são SÍNCRONOS (lidos do espelho de status) — JAMAIS
 * podem virar Promise, pois o SocketService os chama no caminho do handshake.
 */
export interface ISessionManager {
  // ── Síncronos (espelho) ────────────────────────────────────────────────────
  getSessionStatus(sessionId: string): { exists: boolean; status: string; qrCode?: string | null };
  getAllSessions(): Array<{ id: string; status: string; qrCode: string | null }>;
  getSessionInfo(sessionId: string): SessionInfo;
  triggerReboot(sessionId: string): void;

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  startSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  loadSavedSessions(): Promise<void>;

  // ── Painel ────────────────────────────────────────────────────────────────
  getAdminSnapshot(): AdminSessionRow[];

  // ── Operações por sessão (RPC no modo isolado) ──────────────────────────────
  sendMessage(
    sessionId: string,
    to: string,
    text: string,
    mediaType?: MediaType,
    mediaBuffer?: Buffer,
    mediaMime?: string,
    quotedMessageId?: string,
  ): Promise<SendMessageResult>;
  sendLocation(
    sessionId: string,
    to: string,
    latitude: number,
    longitude: number,
    options?: { name?: string; address?: string; url?: string },
  ): Promise<SendMessageResult>;
  getMessages(sessionId: string, number: string, limit?: number): Promise<any[]>;
  editMessage(sessionId: string, number: string, messageId: string, newText: string): Promise<any>;
  deleteMessage(sessionId: string, number: string, messageId: string): Promise<any>;
  forwardMessage(sessionId: string, fromNumber: string, messageId: string, toNumber: string): Promise<void>;
  reactToMessage(sessionId: string, number: string, messageId: string, emoji: string): Promise<any>;
  markAsRead(sessionId: string, chatId: string): Promise<void>;
  checkNumber(sessionId: string, number: string): Promise<any>;
  getContacts(sessionId: string, opts?: { withProfilePic?: boolean }): Promise<any[]>;
  searchContacts(sessionId: string, query: string, opts?: { withProfilePic?: boolean }): Promise<any[]>;
  getGroups(sessionId: string): Promise<any[]>;
  getGroupInfo(sessionId: string, groupId: string): Promise<any>;
  getGroupMembers(sessionId: string, groupId: string): Promise<any[]>;
}
