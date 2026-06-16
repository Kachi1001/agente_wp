import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { logger } from '../utils/logger';

// ──────────────────────────────────────────────────────────────────────────────
// Auth do painel /admin via SSO da Central (mesmo padrão do LogController).
//
// Valida o JWT (Bearer) contra a Central e exige o papel configurado (default
// 'admin'). Opcionalmente, um ADMIN_TOKEN serve de bypass M2M/dev — ativo SÓ
// quando a variável está definida. Sem ADMIN_TOKEN e sem JWT válido → 401.
// ──────────────────────────────────────────────────────────────────────────────

const CENTRAL_URL =
  process.env.CENTRAL_URL || process.env.CENTRAL_AUTH_URL || 'http://10.0.0.139:4000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// Papel exigido. Vazio = qualquer usuário autenticado serve.
const REQUIRED_ROLE = process.env.ADMIN_REQUIRED_ROLE ?? 'admin';

export function adminBypassEnabled(): boolean { return !!ADMIN_TOKEN; }
export { CENTRAL_URL };

function extractBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.substring(7);
  const q = req.query.token as string | undefined;
  return q || null;
}

export const adminAuth = async (req: Request, res: Response, next: NextFunction) => {
  // Bypass M2M/dev opcional (só quando ADMIN_TOKEN está definido no ambiente).
  if (ADMIN_TOKEN) {
    const t = (req.headers['x-admin-token'] as string | undefined) || (req.query.admin_token as string | undefined);
    if (t === ADMIN_TOKEN) return next();
  }

  const token = extractBearer(req);
  if (!token) {
    return res.status(401).json({ error: 'Não autenticado — faça login (SSO).' });
  }

  try {
    const { data } = await axios.get(`${CENTRAL_URL}/api/v1/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });

    if (!data?.valid) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    const user = data.user ?? data;
    const role = user?.role;
    if (REQUIRED_ROLE && role !== REQUIRED_ROLE) {
      logger.warn(`[Admin] Acesso negado — papel "${role}" ≠ "${REQUIRED_ROLE}" (${req.method} ${req.path})`);
      return res.status(403).json({ error: `Acesso restrito a ${REQUIRED_ROLE}` });
    }

    (req as any).user = user;
    return next();
  } catch (err: any) {
    if (err.response) {
      logger.warn(`[Admin] SSO rejeitou o token (${err.response.status}) — ${req.method} ${req.path}`);
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
    logger.error(`[Admin] Falha ao contatar SSO: ${err.message}`);
    return res.status(503).json({ error: 'Serviço de autenticação indisponível' });
  }
};
