import { Request, Response } from 'express';
import { sessionManager } from '../services/SessionManager';
import { logger } from '../utils/logger';

export const messageController = {
  async send(req: Request, res: Response): Promise<void> {
    const { sessionId, to, text, mediaType, quotedMessageId } = req.body;
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
        resp = await sessionManager.sendMessage(sessionId, to, text || '', mediaType, file.buffer, file.mimetype, quotedMessageId);
      } else {
        // Envio de texto simples
        resp = await sessionManager.sendMessage(sessionId, to, text, undefined, undefined, undefined, quotedMessageId);
      }
      res.status(200).json({ success: true, message: resp });
    } catch (error: any) {
      logger.error(error, `Failed to send message from session ${sessionId}`);
      res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
  },
  async edit(req: Request, res: Response): Promise<void> {
    const { sessionId, to, messageId, newText } = req.body;

    if (!sessionId || !to || !messageId || !newText) {
      res.status(400).json({ error: 'Missing required parameters: sessionId, to, messageId, newText' });
      return;
    }

    try {
      await sessionManager.editMessage(sessionId, to, messageId, newText);
      res.status(200).json({ success: true, message: 'Message edited successfully' });
    } catch (error: any) {
      logger.error(error, `Failed to edit message ${messageId} in session ${sessionId}`);
      res.status(500).json({ error: 'Failed to edit message', details: error.message });
    }
  },
  async delete(req: Request, res: Response): Promise<void> {
    const { sessionId, to, messageId } = req.body;

    if (!sessionId || !to || !messageId) {
      res.status(400).json({ error: 'Missing required parameters: sessionId, to, messageId' });
      return;
    }

    try {
      await sessionManager.deleteMessage(sessionId, to, messageId);
      res.status(200).json({ success: true, message: 'Message deleted for everyone' });
    } catch (error: any) {
      logger.error(error, `Failed to delete message ${messageId} in session ${sessionId}`);
      res.status(500).json({ error: 'Failed to delete message', details: error.message });
    }
  },
  async react(req: Request, res: Response): Promise<void> {
    const { sessionId, to, messageId, emoji } = req.body;

    if (!sessionId || !to || !messageId || !emoji) {
      res.status(400).json({ error: 'Missing required parameters: sessionId, to, messageId, emoji' });
      return;
    }

    try {
      await sessionManager.reactToMessage(sessionId, to, messageId, emoji);
      res.status(200).json({ success: true, message: 'Reaction added' });
    } catch (error: any) {
      logger.error(error, `Failed to react to message ${messageId} in session ${sessionId}`);
      res.status(500).json({ error: 'Failed to react to message', details: error.message });
    }
  },
  async forward(req: Request, res: Response): Promise<void> {
    const { sessionId, from, messageId, to } = req.body;

    if (!sessionId || !from || !messageId || !to) {
      res.status(400).json({ error: 'Missing required parameters: sessionId, from, messageId, to' });
      return;
    }

    try {
      await sessionManager.forwardMessage(sessionId, from, messageId, to);
      res.status(200).json({ success: true, message: 'Message forwarded successfully' });
    } catch (error: any) {
      logger.error(error, `Failed to forward message ${messageId} in session ${sessionId}`);
      res.status(500).json({ error: 'Failed to forward message', details: error.message });
    }
  },
  async getHistory(req: Request, res: Response): Promise<void> {
    const { sessionId, number, limit } = req.query;
    
    // Explicit validation and type narrowing
    if (typeof sessionId !== 'string' || typeof number !== 'string') {
      res.status(400).json({ error: 'Missing or invalid required query parameters: sessionId, number (must be strings)' });
      return;
    }


    try {
      const messages = await sessionManager.getMessages(
        sessionId,
        number,
        limit ? parseInt(limit as string) : 200
      );
      res.status(200).json({ success: true, history: messages });
    } catch (error: any) {
      logger.error(error, `Failed to fetch history for session ${sessionId}, number ${number}`);
      res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
    }
  }
};
