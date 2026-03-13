import { Router } from 'express';
import { contactController } from '../controllers/ContactController';

const router = Router();

router.get('/:sessionId/list', contactController.list);

export default router;
