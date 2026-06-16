import { Router } from 'express';
import path from 'path';
import { adminController } from '../controllers/AdminController';
import { adminAuth } from '../middleware/adminAuth';

const router = Router();
const PANEL_DIR = path.join(process.cwd(), 'public', 'admin');

// ── Painel estático (HTML/JS) — aberto; os DADOS é que são protegidos ──────────
router.get('/', (_req, res) => res.sendFile(path.join(PANEL_DIR, 'index.html')));
router.get('/app.js', (_req, res) => res.sendFile(path.join(PANEL_DIR, 'app.js')));

// ── Bootstrap + login SSO: abertos (o login proxia para a Central) ─────────────
router.get('/api/config', adminController.config);
router.post('/api/login', adminController.login);

// ── Dados protegidos por ADMIN_TOKEN ───────────────────────────────────────────
router.get('/api/sessions', adminAuth, adminController.sessions);
router.get('/api/logs', adminAuth, adminController.logs);
router.get('/api/clients', adminAuth, adminController.clients);

export default router;
