import type { ISessionManager } from './types';
import { logger } from '../utils/logger';

// ──────────────────────────────────────────────────────────────────────────────
// Shim de seleção de implementação.
//
// Mantém o símbolo `sessionManager` no mesmo caminho de import — controllers,
// rotas, sockets e index.ts continuam idênticos.
//
//   WORKER_MODE != '0'  (padrão) → Supervisor: 1 processo filho isolado por sessão.
//   WORKER_MODE == '0'           → LegacySessionManager: monólito in-process (fallback).
//
// Rollback de produção sem redeploy: defina WORKER_MODE=0 no PM2 e reinicie.
// ──────────────────────────────────────────────────────────────────────────────

const USE_WORKER = process.env.WORKER_MODE !== '0';

let impl: ISessionManager;

if (USE_WORKER) {
  const { Supervisor } = require('./Supervisor');
  impl = new Supervisor();
  logger.info('[SessionManager] Modo ISOLADO (Supervisor): 1 processo por sessão.');
} else {
  const { legacySessionManager } = require('./LegacySessionManager');
  impl = legacySessionManager;
  logger.info('[SessionManager] Modo LEGADO (monólito in-process). WORKER_MODE=0.');
}

export const sessionManager: ISessionManager = impl;
