import { Request, Response } from 'express';
import axios from 'axios';
import { sessionManager } from '../services/SessionManager';
import { socketService } from '../services/SocketService';
import { readLogs } from '../utils/logger';
import { readSessionLogs } from '../utils/sessionLog';
import { adminBypassEnabled, CENTRAL_URL } from '../middleware/adminAuth';

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
  config(_req: Request, res: Response): void {
    res.status(200).json({
      authEnabled: process.env.AUTH_ENABLED === 'true',
      sso: true,                          // /admin valida o usuário via SSO da Central
      bypassEnabled: adminBypassEnabled(),// ADMIN_TOKEN disponível (dev/M2M)
      workerMode: process.env.WORKER_MODE !== '0',
    });
  },

  // POST /admin/api/login — proxy do login SSO da Central (evita CORS no painel).
  // Recebe { username, password } e devolve { token, user } da Central.
  async login(req: Request, res: Response): Promise<void> {
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: 'username e password são obrigatórios' });
      return;
    }
    try {
      const { data } = await axios.post(
        `${CENTRAL_URL}/api/auth/login`,
        { username, password },
        { timeout: 8000 },
      );
      res.status(200).json({ token: data.token, user: data.user });
    } catch (err: any) {
      if (err.response) {
        res.status(err.response.status).json({ error: err.response.data?.error || 'Credenciais inválidas' });
        return;
      }
      res.status(503).json({ error: 'Serviço de autenticação indisponível' });
    }
  },
};
