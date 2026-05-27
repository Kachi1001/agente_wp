import { Router } from 'express';
import { groupController } from '../controllers/GroupController';

const router = Router();

// Lista todos os grupos da sessão (com total de participantes)
// GET /group/list/:sessionId
router.get('/list/:sessionId', groupController.list);

// Informações detalhadas de um grupo (descrição, invite link, etc.)
// GET /group/:sessionId/info/:groupId
router.get('/:sessionId/info/:groupId', groupController.info);

// Lista os participantes de um grupo
// GET /group/:sessionId/members/:groupId
router.get('/:sessionId/members/:groupId', groupController.members);

export default router;
