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
  },

  async check(req: Request, res: Response): Promise<void> {
    const { sessionId, number } = req.params;

    if (!sessionId || !number) {
      res.status(400).json({ error: 'Missing required parameters: sessionId, number' });
      return;
    }

    try {
      const result = await sessionManager.checkNumber(sessionId as string, number as string);
      res.status(200).json({ success: true, ...result });
    } catch (error: any) {
      logger.error(error, `Failed to check number ${number} for session ${sessionId}`);
      res.status(500).json({ error: 'Failed to verify number', details: error.message });
    }
  }
};
