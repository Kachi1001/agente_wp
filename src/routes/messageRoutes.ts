import { Router } from 'express';
import { messageController } from '../controllers/MessageController';

const router = Router();

router.post('/send', messageController.send);

export default router;
