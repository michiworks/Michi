import { Router, type Request } from 'express';
import { parseBlockSubmissionHost, parseBlockSubmissionHostKey } from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { PageWriteError } from '../services/pages/core';
import { BlockSubmissionExistsError, listBlockSubmissions, recordBlockSubmission } from '../services/pages/blockSubmissions';
import { pageBody, pageErrors, pageId, pageQuery, route } from './pageRouteKit';

const owner = (req: Request): string => (req as Request & { user?: { id?: string } }).user?.id ?? LOCAL_AGENT_OWNER_ID;

/**
 * What a person sent through a form, poll or choice block on a page or in a
 * chat message. Mount at /api behind the shared access guards; the owner is
 * always the authenticated caller and every host is looked up in that
 * owner's workspace.
 */
export function setupBlockSubmissionRoutes(): Router {
  const router = Router();
  router.get('/workspaces/:workspaceId/block-submissions', route((req, res) => {
    pageQuery(req, ['host']);
    const host = parseBlockSubmissionHostKey(req.query.host);
    if (!host) throw new PageWriteError(400, 'invalid', 'Invalid host');
    res.json({ submissions: listBlockSubmissions(pageId(req.params.workspaceId, 'workspaceId'), owner(req), host) });
  }));
  router.post('/workspaces/:workspaceId/block-submissions', route((req, res) => {
    pageQuery(req, []);
    const data = pageBody(req, ['host', 'blockId', 'signature', 'value', 'text']);
    const host = parseBlockSubmissionHost(data.host);
    if (!host) throw new PageWriteError(400, 'invalid', 'Invalid host');
    try {
      const submission = recordBlockSubmission({
        workspaceId: pageId(req.params.workspaceId, 'workspaceId'), ownerUserId: owner(req), host,
        blockId: data.blockId, signature: data.signature, value: data.value, text: data.text,
      });
      res.status(201).json({ submission });
    } catch (error) {
      if (!(error instanceof BlockSubmissionExistsError)) throw error;
      res.status(409).json({ code: 'already_submitted', submission: error.submission,
        error: { code: 'already_submitted', message: 'This block was already submitted' } });
    }
  }));
  router.use(pageErrors('Unable to complete block submission request'));
  return router;
}
