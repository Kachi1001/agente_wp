import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

// ──────────────────────────────────────────────────────────────────────────────
// Auth do painel /admin via SSO da Central (fluxo de REDIRECT — runbook Tecnika).
//
//   Navegação sem token  → 302 para  {CENTRAL}/login?redirect=&app_id=&error=
//   Central autentica    → volta para  /admin?sso_token=<jwt>
//   Aqui                 → salva cookie sso_token, limpa a URL, valida em
//                          {CENTRAL}/auth/verify e checa acesso ao app (apps).
//
// Sem página de login local. Requests de API (Accept != text/html) recebem JSON
// 401/403 e o front cuida do redirect.
// ──────────────────────────────────────────────────────────────────────────────

const CENTRAL_AUTH_URL =
  process.env.CENTRAL_AUTH_URL || process.env.CENTRAL_URL || 'http://10.0.0.139:4000';
const APP_ID = process.env.APP_ID || '';

export const ADMIN_CENTRAL_URL = CENTRAL_AUTH_URL;
export const ADMIN_APP_ID = APP_ID;

function currentUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host');
  return `${proto}://${host}${req.originalUrl}`;
}

function loginRedirect(req: Request, errorCode: string): string {
  const params = new URLSearchParams({
    redirect: currentUrl(req),
    app_id: String(APP_ID),
    error: errorCode,
  });
  return `${CENTRAL_AUTH_URL}/login?${params.toString()}`;
}

function wantsHtml(req: Request): boolean {
  return (req.headers.accept || '').includes('text/html');
}

function readCookie(req: Request, name: string): string | null {
  const c = req.headers.cookie;
  if (!c) return null;
  const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export const adminAuth = async (req: Request, res: Response, next: NextFunction) => {
  // 1) Primeiro acesso vindo da Central (?sso_token=...): persiste em cookie e
  //    limpa a URL (evita vazar o token no histórico/referer).
  const incoming = (req.query.sso_token as string) || (req.query.token as string);
  if (incoming) {
    res.cookie('sso_token', incoming, {
      maxAge: 8 * 60 * 60 * 1000, // 8h
      httpOnly: false,            // o painel (SPA) lê o cookie para montar o Bearer
      sameSite: 'lax',
      path: '/',
    });
    const cleanUrl = req.originalUrl
      .replace(/([?&])(sso_token|token)=[^&]*(&|$)/, '$1')
      .replace(/[?&]$/, '');
    return res.redirect(cleanUrl || '/admin');
  }

  // 2) Resolve o token: Bearer (API) ou cookie sso_token (navegação).
  let token = req.headers.authorization?.split(' ')[1] || readCookie(req, 'sso_token');

  // 3) Bypass M2M: webhookSecret como Bearer (consistente com o authMiddleware).
  if (token && config.webhookSecret && token === config.webhookSecret) return next();

  if (!token) {
    if (wantsHtml(req)) return res.redirect(loginRedirect(req, 'no_token'));
    return res.status(401).json({ valid: false, error: 'Token ausente.' });
  }

  try {
    const { data } = await axios.get(`${CENTRAL_AUTH_URL}/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
      params: APP_ID ? { app_id: APP_ID } : undefined,
      timeout: 8000,
    });

    if (!data?.valid) {
      if (wantsHtml(req)) return res.redirect(loginRedirect(req, 'invalid_token'));
      return res.status(401).json({ valid: false, error: 'Token inválido ou expirado.' });
    }

    // Permissão por app (modelo da Central). Aceita tanto `apps` (shape legado)
    // quanto `allowedApps[].id` (shape v1). Só barra se a lista existir e não
    // incluir este app — senão degrada para "permitido" (fallback por origem).
    const apps: any[] | null = Array.isArray(data.apps)
      ? data.apps
      : Array.isArray(data.allowedApps)
        ? data.allowedApps.map((a: any) => a?.id ?? a?.identifier ?? a)
        : null;
    if (APP_ID && apps && !apps.map(String).includes(String(APP_ID))) {
      if (wantsHtml(req)) return res.redirect(loginRedirect(req, 'forbidden'));
      return res.status(403).json({ valid: false, error: 'Sem permissão para este sistema.' });
    }

    (req as any).user = data.user ?? data;
    return next();
  } catch (err: any) {
    if (err.response?.status === 401) {
      if (wantsHtml(req)) return res.redirect(loginRedirect(req, 'session_expired'));
      return res.status(401).json({ valid: false, error: 'Sessão expirada.' });
    }
    logger.error(`[Admin] Falha ao contatar SSO: ${err.message}`);
    if (wantsHtml(req)) {
      return res.status(502).type('text/plain').send('Falha ao contatar a Central SSO.');
    }
    return res.status(502).json({ valid: false, error: 'Falha de comunicação com a Central SSO.' });
  }
};
