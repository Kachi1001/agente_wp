import { Request, Response } from 'express';
import { sessionManager } from '../services/SessionManager';
import { logger } from '../utils/logger';

export const contactController = {
  async list(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;

    if (!sessionId) {
      res.status(400).json({ error: 'Missing required parameter: sessionId' });
      return;
    }
    
    try {
      const contacts = await sessionManager.getContacts(sessionId as string);
      res.status(200).json({ success: true, contacts });
    } catch (error: any) {
      logger.error(error, `Failed to fetch contacts for session ${sessionId}`);
      res.status(500).json({ error: 'Failed to fetch contacts', details: error.message });
    }
  }
};
