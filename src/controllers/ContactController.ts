import { Request, Response } from 'express';
import { sessionManager } from '../services/SessionManager';
import { logger } from '../utils/logger';

export const contactController = {
  /**
   * GET /:sessionId/list
   * Lista todos os contatos da sessão.
   * Query params:
   *   - withProfilePic=true  → inclui profilePicUrl (mais lento)
   */
  async list(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;

    if (!sessionId) {
      res.status(400).json({ error: 'Missing required parameter: sessionId' });
      return;
    }

    const withProfilePic = req.query.withProfilePic === 'true';

    try {
      const contacts = await sessionManager.getContacts(sessionId as string, { withProfilePic });
      res.status(200).json({ success: true, total: contacts.length, contacts });
    } catch (error: any) {
      logger.error(error, `Failed to fetch contacts for session ${sessionId}`);
      res.status(500).json({ error: 'Failed to fetch contacts', details: error.message });
    }
  },

  /**
   * GET /:sessionId/search?q=<query>
   * Busca contatos por nome, pushname ou número.
   * Query params:
   *   - q=<string>           → termo de busca (obrigatório)
   *   - withProfilePic=true  → inclui profilePicUrl
   */
  async search(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const query = (req.query.q as string) || '';
    const withProfilePic = req.query.withProfilePic === 'true';

    if (!sessionId) {
      res.status(400).json({ error: 'Missing required parameter: sessionId' });
      return;
    }

    if (!query) {
      res.status(400).json({ error: 'Missing required query param: q' });
      return;
    }

    try {
      const contacts = await sessionManager.searchContacts(sessionId as string, query, { withProfilePic });
      res.status(200).json({ success: true, query, total: contacts.length, contacts });
    } catch (error: any) {
      logger.error(error, `Failed to search contacts for session ${sessionId}`);
      res.status(500).json({ error: 'Failed to search contacts', details: error.message });
    }
  },

  /**
   * GET /:sessionId/check/:number
   * Verifica se um número está registrado no WhatsApp.
   */
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
