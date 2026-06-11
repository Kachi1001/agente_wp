import { Router } from 'express';
import { logController } from '../controllers/LogController';

const router = Router();

// GET /api/logs — autorização própria (admin da Central), independente de AUTH_ENABLED.
router.get('/', logController.list);

export default router;
