import type { SessionState, SessionInfo } from './types';

// ──────────────────────────────────────────────────────────────────────────────
// Protocolo IPC entre o Supervisor (pai) e cada sessionWorker (filho).
//
// Serialização: usamos o serializador 'json' PADRÃO do child_process. Por isso a
// mídia de saída do sendMessage cruza como STRING base64 (não Buffer) — o worker
// já constrói o MessageMedia a partir de base64, então é o formato natural.
// Toda mídia de ENTRADA é gravada em disco compartilhado dentro do filho; só as
// URLs cruzam de volta. Nenhum byte bruto trafega no sentido filho→pai.
// ──────────────────────────────────────────────────────────────────────────────

export const IPC_PROTOCOL_VERSION = 1 as const;

/** Eventos de domínio que o filho repassa e o pai injeta no NotifyService. */
export type WorkerEventType =
  | 'message.received'      // notifyMessage
  | 'message.edit'          // notifyMessageEdit
  | 'message.delete'        // notifyMessageDelete
  | 'message.reaction'      // notifyMessageReaction
  | 'message.ack'           // notifyMessageAck
  | 'session.connected'     // notifyStatus(...'session.connected')
  | 'session.authenticated';// notifyStatus(...'session.authenticated')
// Obs.: 'session.disconnected' NÃO é um evento do filho — o pai o sintetiza na
// transição do espelho para DISCONNECTED (cobre também o caso de crash sem evento).

/** Métodos assíncronos que viram request/response RPC dentro do filho. */
export type RpcMethod =
  | 'sendMessage'
  | 'getMessages'
  | 'editMessage'
  | 'deleteMessage'
  | 'forwardMessage'
  | 'reactToMessage'
  | 'markAsRead'
  | 'checkNumber'
  | 'getContacts'
  | 'searchContacts'
  | 'getGroups'
  | 'getGroupInfo'
  | 'getGroupMembers'
  | 'getSessionInfo';

/** Erro serializado — Error não sobrevive ao JSON do IPC. */
export interface SerializedError {
  message: string;
  name: string;
  code?: string;
  /** Computado no filho via isDeadFrameError(); o pai decide o respawn por isto. */
  isDeadFrame: boolean;
}

// ── Pai → Filho ─────────────────────────────────────────────────────────────
export type ParentToChild =
  | { kind: 'rpc'; id: number; method: RpcMethod; args: any[] }
  | { kind: 'ping'; id: number }
  | { kind: 'shutdown'; mode: 'graceful' | 'logout' };

// ── Filho → Pai ─────────────────────────────────────────────────────────────
export type ChildToParent =
  | { kind: 'hello'; sessionId: string; protocol: number; pid: number }
  // 'state' atualiza o espelho SÍNCRONO do pai (status/qrCode/info):
  | { kind: 'state'; status: SessionState; qrCode?: string | null; info?: SessionInfo | null; reason?: string }
  // 'event' é repassado ao NotifyService com payload byte-a-byte igual ao atual:
  | { kind: 'event'; eventType: WorkerEventType; data: any }
  | { kind: 'rpc:res'; id: number; ok: true; result: any }
  | { kind: 'rpc:res'; id: number; ok: false; error: SerializedError }
  | { kind: 'pong'; id: number }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; event: string; meta?: Record<string, unknown>; ts?: string }
  | { kind: 'fatal'; reason: string };
