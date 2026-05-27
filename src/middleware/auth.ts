import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

const CENTRAL_AUTH_URL = process.env.CENTRAL_AUTH_URL || 'http://10.0.0.139:4000';
const APP_ID = process.env.APP_ID || '';

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  const queryToken = req.query.token as string | undefined;
  if (queryToken) return queryToken;

  return null;
}

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const token = extractToken(req);

  if (!token) {
    logger.warn(`[Auth] Token não fornecido — ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  // Machine-to-machine: aceita o webhookSecret diretamente como token
  if (config.webhookSecret && token === config.webhookSecret) {
    logger.info(`[Auth] Acesso M2M autorizado — ${req.method} ${req.path}`);
    return next();
  }

  // Validação JWT via Central SSO
  try {
    const { data } = await axios.get(`${CENTRAL_AUTH_URL}/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
      params: APP_ID ? { app_id: APP_ID } : undefined,
      timeout: 5000,
    });

    if (!data?.valid) {
      logger.warn(`[Auth] Token inválido ou expirado — ${req.method} ${req.path}`);
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    if (APP_ID && data.apps && !data.apps.includes(APP_ID)) {
      logger.warn(`[Auth] App sem permissão (${APP_ID}) — ${req.method} ${req.path}`);
      return res.status(403).json({ error: 'Aplicação sem permissão' });
    }

    (req as any).user = data.user ?? data;
    return next();
  } catch (err: any) {
    if (err.response) {
      logger.warn(`[Auth] SSO rejeitou o token (${err.response.status}) — ${req.method} ${req.path}`);
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
    logger.error(`[Auth] Falha ao contatar SSO: ${err.message}`);
    return res.status(503).json({ error: 'Serviço de autenticação indisponível' });
  }
};
