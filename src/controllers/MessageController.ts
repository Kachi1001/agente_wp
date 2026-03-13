import { Request, Response } from 'express';
import { sessionManager } from '../services/SessionManager';
import { logger } from '../utils/logger';

export const messageController = {
  async send(req: Request, res: Response): Promise<void> {
    const { sessionId, to, text, mediaType } = req.body;
    const file = req.file;

    if (!sessionId || !to || (!text && !file)) {
      res.status(400).json({ error: 'Missing required parameters: sessionId, to and (text or file)' });
      return;
    }

    const status = sessionManager.getSessionStatus(sessionId);
    if (!status.exists || status.status !== 'CONNECTED') {
      res.status(400).json({ error: `Session ${sessionId} is not connected.` });
      return;
    }

    try {
      // Se houver arquivo no multipart/form-data, envia via Buffer (Memória)
      let resp;
      if (file) {
        resp = await sessionManager.sendMessage(sessionId, to, text || '', mediaType, file.buffer, file.mimetype);
      } else {
        // Envio de texto simples
        resp = await sessionManager.sendMessage(sessionId, to, text);
      }
      res.status(200).json({ success: true, message: resp });
    } catch (error: any) {
      logger.error(error, `Failed to send message from session ${sessionId}`);
      res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
  }
};
