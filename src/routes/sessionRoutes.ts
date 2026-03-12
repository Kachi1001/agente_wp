import { Router } from 'express';
import { sessionController } from '../controllers/SessionController';

const router = Router();

router.post('/start/:id', sessionController.start);
router.get('/status/:id', sessionController.status);
router.get('/qr/:id', sessionController.qrCode);
router.delete('/stop/:id', sessionController.stop);

export default router;
