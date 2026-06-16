import { Request, Response } from 'express';
import { sessionManager } from '../services/SessionManager';
import { socketService } from '../services/SocketService';
import { readLogs } from '../utils/logger';
import { readSessionLogs } from '../utils/sessionLog';
import { ADMIN_CENTRAL_URL, ADMIN_APP_ID } from '../middleware/adminAuth';

// ──────────────────────────────────────────────────────────────────────────────
// API do painel /admin. Apenas dados de operação — as ações (start/restart/stop/
// qr) reusam as rotas /session/* já existentes.
// ──────────────────────────────────────────────────────────────────────────────

export const adminController = {
  // GET /admin/api/sessions — snapshot enriquecido (síncrono, do espelho).
  sessions(_req: Request, res: Response): void {
    res.status(200).json({ ts: new Date().toISOString(), sessions: sessionManager.getAdminSnapshot() });
  },

  // GET /admin/api/logs — cauda do NDJSON. Com ?session=<id> retorna o histórico
  // DAQUELA sessão (terminal por sessão); sem ele, o log global. Capado a 1000.
  logs(req: Request, res: Response): void {
    const { level, date, since, session } = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const logs = session
      ? readSessionLogs(session, { level, date, since, limit })
      : readLogs({ level, date, since, limit });
    res.status(200).json({ count: logs.length, session: session ?? null, logs });
  },

  // GET /admin/api/clients — apps consumidores conectados via Socket.IO.
  clients(_req: Request, res: Response): void {
    res.status(200).json({ ts: new Date().toISOString(), clients: socketService.getConnectedClients() });
  },

  // GET /admin/api/config — bootstrap do painel (aberto, sem segredos).
  // Informa a Central e o app_id para o front montar o redirect de login.
  config(_req: Request, res: Response): void {
    res.status(200).json({
      authEnabled: process.env.AUTH_ENABLED === 'true',
      sso: true,
      centralUrl: ADMIN_CENTRAL_URL,
      appId: ADMIN_APP_ID,
      workerMode: process.env.WORKER_MODE !== '0',
    });
  },

  // GET /admin/api/me — usuário autenticado (preenchido pelo adminAuth via SSO).
  me(req: Request, res: Response): void {
    res.status(200).json({ user: (req as any).user ?? null });
  },
};
