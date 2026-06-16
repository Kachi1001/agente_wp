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

// ── Painel estático (HTML/JS) — aberto; os DADOS é que são protegidos ──────────
router.get('/', (_req, res) => sendPanel(res, 'index.html'));
router.get('/app.js', (_req, res) => sendPanel(res, 'app.js'));

// ── Bootstrap + login SSO: abertos (o login proxia para a Central) ─────────────
router.get('/api/config', adminController.config);
router.post('/api/login', adminController.login);

// ── Dados protegidos por ADMIN_TOKEN ───────────────────────────────────────────
router.get('/api/sessions', adminAuth, adminController.sessions);
router.get('/api/logs', adminAuth, adminController.logs);
router.get('/api/clients', adminAuth, adminController.clients);

export default router;
