import { Request, Response } from 'express';
import axios from 'axios';
import { logger, readLogs } from '../utils/logger';

// A Central encaminha o JWT do admin; validamos de volta nela.
// Mantém compatibilidade com CENTRAL_AUTH_URL (já usado no SSO) e cai no default.
const CENTRAL_URL =
  process.env.CENTRAL_URL || process.env.CENTRAL_AUTH_URL || 'http://10.0.0.139:4000';

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.substring(7);
  return null;
}

export const logController = {
  // GET /api/logs — somente admin da Central. Logs são sensíveis.
  async list(req: Request, res: Response) {
    const token = extractToken(req);
    if (!token) {
      logger.warn('[Logs] Requisição sem token', { path: req.path });
      return res.status(401).json({ error: 'Sem token' });
    }

    // Valida o JWT de volta na Central.
    let verify: any;
    try {
      const r = await axios.get(`${CENTRAL_URL}/api/v1/auth/verify`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 8000,
      });
      verify = r.data;
    } catch (err: any) {
      logger.error(err, '[Logs] Falha ao validar token na Central');
      return res.status(502).json({ error: 'Falha ao validar token' });
    }

    if (!verify?.valid || verify.user?.role !== 'admin') {
      logger.warn('[Logs] Acesso negado — não é admin', { role: verify?.user?.role });
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const { level, date, since } = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

    const logs = readLogs({ level, date, since, limit });
    return res.json({ count: logs.length, logs });
  },
};
