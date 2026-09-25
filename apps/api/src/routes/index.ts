import { Router } from 'express';
import { authRouter } from './auth.js';
import { metaRouter } from './meta.js';
import { automationsRouter, retriggerRunsRouter } from './automations.js';
import { conversationsRouter, inboxRouter } from './conversations.js';
import { contactsRouter } from './contacts.js';
import { accountsRouter } from './accounts.js';
import { aiRouter } from './ai.js';
import { bioRouter } from './bio.js';
import { integrationsRouter } from './integrations.js';
import { billingRouter } from './billing.js';
import { adminRouter } from './admin.js';

/**
 * Everything under /api/v1. Sub-routers own their own auth requirements:
 * `authRouter` is partly public, the rest sit behind requireAuth.
 */
export const apiRouter: Router = Router();

apiRouter.get('/health', (_req, res) => {
  res.json({ data: { status: 'ok' } });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/meta', metaRouter);
apiRouter.use('/automations', automationsRouter);
apiRouter.use('/retrigger/runs', retriggerRunsRouter);
apiRouter.use('/conversations', conversationsRouter);
apiRouter.use('/inbox', inboxRouter);
apiRouter.use('/contacts', contactsRouter);
apiRouter.use('/accounts', accountsRouter);
apiRouter.use('/ai', aiRouter);
apiRouter.use('/bio', bioRouter);
apiRouter.use('/integrations', integrationsRouter);
apiRouter.use('/billing', billingRouter);
apiRouter.use('/admin', adminRouter);
