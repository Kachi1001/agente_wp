import { Request, Response } from 'express';
import { sessionManager } from '../services/SessionManager';
import { logger } from '../index';

export const messageController = {
  async send(req: Request, res: Response): Promise<void> {
    const { sessionId, to, text, isGroup } = req.body;

    if (!sessionId || !to || !text) {
      res.status(400).json({ error: 'Missing required parameters: sessionId, to, text' });
      return;
    }

    const status = sessionManager.getSessionStatus(sessionId);
    if (!status.exists || status.status !== 'CONNECTED') {
      res.status(400).json({ error: `Session ${sessionId} is not connected.` });
      return;
    }

    try {
      // Internally gain access to the socket (in a real app, you might expose a send method in SessionManager instead)
      // For simplicity in this architecture, we retrieve it from the manager's private map using a workaround
      // or we add a specific `sendMessage` method to SessionManager. Let's assume we add it to SessionManager.

      await sessionManager.sendMessage(sessionId, to, text, isGroup);

      res.status(200).json({ success: true, message: 'Message sent successfully' });
    } catch (error: any) {
      logger.error(error, `Failed to send message from session ${sessionId}`);
      res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
  }
};
