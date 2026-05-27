import { Request, Response } from 'express';
import { sessionManager } from '../services/SessionManager';
import { logger } from '../utils/logger';

export const groupController = {
  /** GET /group/list/:sessionId */
  async list(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing required parameter: sessionId' });
      return;
    }
    try {
      const groups = await sessionManager.getGroups(sessionId as string);
      res.status(200).json({ success: true, total: groups.length, groups });
    } catch (error: any) {
      logger.error(error, `Failed to fetch groups for session ${sessionId}`);
      res.status(500).json({ error: 'Failed to fetch groups', details: error.message });
    }
  },

  /** GET /group/:sessionId/info/:groupId */
  async info(req: Request, res: Response): Promise<void> {
    const { sessionId, groupId } = req.params;
    if (!sessionId || !groupId) {
      res.status(400).json({ error: 'Missing required parameters: sessionId, groupId' });
      return;
    }
    try {
      const group = await sessionManager.getGroupInfo(sessionId as string, groupId as string);
      res.status(200).json({ success: true, group });
    } catch (error: any) {
      logger.error(error, `Failed to fetch group info ${groupId} for session ${sessionId}`);
      res.status(500).json({ error: 'Failed to fetch group info', details: error.message });
    }
  },

  /** GET /group/:sessionId/members/:groupId */
  async members(req: Request, res: Response): Promise<void> {
    const { sessionId, groupId } = req.params;
    if (!sessionId || !groupId) {
      res.status(400).json({ error: 'Missing required parameters: sessionId, groupId' });
      return;
    }
    try {
      const members = await sessionManager.getGroupMembers(sessionId as string, groupId as string);
      res.status(200).json({ success: true, total: members.length, members });
    } catch (error: any) {
      logger.error(error, `Failed to fetch members of group ${groupId} for session ${sessionId}`);
      res.status(500).json({ error: 'Failed to fetch group members', details: error.message });
    }
  },
};
