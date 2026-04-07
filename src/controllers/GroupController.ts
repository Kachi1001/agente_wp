import { Request, Response } from 'express';
import { sessionManager } from '../services/SessionManager';
import { logger } from '../utils/logger';

export const groupController = {
  async list(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;

    if (!sessionId) {
      res.status(400).json({ error: 'Missing required parameter: sessionId' });
      return;
    }

    try {
      const groups = await sessionManager.getGroups(sessionId as string);
      res.status(200).json({ success: true, groups });
    } catch (error: any) {
      logger.error(error, `Failed to fetch groups for session ${sessionId}`);
      res.status(500).json({ error: 'Failed to fetch groups', details: error.message });
    }
  }
};
