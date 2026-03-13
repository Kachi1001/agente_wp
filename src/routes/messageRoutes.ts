import { Router } from 'express';
import { messageController } from '../controllers/MessageController';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/send', upload.single('file'), messageController.send);
router.get('/history', messageController.getHistory);

export default router;
