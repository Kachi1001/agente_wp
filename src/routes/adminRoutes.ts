import { Router } from 'express';
import path from 'path';
import { adminController } from '../controllers/AdminController';
import { adminAuth } from '../middleware/adminAuth';

const router = Router();
const PANEL_DIR = path.join(process.cwd(), 'public', 'admin');

// Serve um arquivo do painel com erro CLARO se ele não foi para o deploy
// (em vez de um ENOENT cru estourando como erro não tratado).
function sendPanel(res: import('express').Response, file: string) {
  res.sendFile(path.join(PANEL_DIR, file), (err) => {
    if (err && !res.headersSent) {
      res.status(500).type('text/plain').send(
        `Painel /admin indisponível: "${file}" não encontrado em ${PANEL_DIR}.\n` +
        `Garanta que public/admin/ foi para o deploy (não pode estar no .gitignore).`,
      );
    }
  });
}

// ── Shell do painel: PROTEGIDO. Navegação sem token → redirect para o SSO da
//    Central; retorno com ?sso_token=... é capturado pelo adminAuth (cookie + URL
//    limpa) antes de servir o HTML. ───────────────────────────────────────────
router.get('/', adminAuth, (_req, res) => sendPanel(res, 'index.html'));

// JS estático: aberto (sem segredos; o cookie já está setado quando carrega).
router.get('/app.js', (_req, res) => sendPanel(res, 'app.js'));

// Bootstrap aberto: Central + app_id para o front montar o redirect de login.
router.get('/api/config', adminController.config);

// ── Dados + identidade: validados via SSO ──────────────────────────────────────
router.get('/api/me', adminAuth, adminController.me);
router.get('/api/sessions', adminAuth, adminController.sessions);
router.get('/api/logs', adminAuth, adminController.logs);
router.get('/api/clients', adminAuth, adminController.clients);

export default router;
