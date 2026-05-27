import { Router } from 'express';
import { sessionController } from '../controllers/SessionController';

const router = Router();

router.get('/', sessionController.list);
router.post('/start/:id', sessionController.start);
router.get('/status/:id', sessionController.status);
router.get('/qr/:id', sessionController.qrCode);
router.get('/info/:id', sessionController.info);
router.post('/restart/:id', sessionController.restart);
router.delete('/stop/:id', sessionController.stop);

export default router;
