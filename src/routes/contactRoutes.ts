import { Router } from 'express';
import { contactController } from '../controllers/ContactController';

const router = Router();

// Lista todos os contatos da sessão
// GET /contacts/:sessionId/list?withProfilePic=true
router.get('/:sessionId/list', contactController.list);

// Busca contatos por nome, pushname ou número
// GET /contacts/:sessionId/search?q=João&withProfilePic=true
router.get('/:sessionId/search', contactController.search);

// Verifica se um número está registrado no WhatsApp
// GET /contacts/:sessionId/check/5511999998888
router.get('/:sessionId/check/:number', contactController.check);

export default router;
