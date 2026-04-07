import { Router } from 'express';
import { groupController } from '../controllers/GroupController';

const router = Router();

router.get('/list/:sessionId', groupController.list);

export default router;
