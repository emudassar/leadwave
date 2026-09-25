import { Router } from 'express';
import { handler, ok } from '../lib/http.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { buildAdminAnalytics } from '../services/analytics.js';

/**
 * The founder's own view of the product: is anyone signing up, is anyone
 * paying. `requireAdmin` gates every route here — nothing under `/admin` is
 * workspace-scoped, so a workspace admin is not enough.
 */
export const adminRouter: Router = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get(
  '/analytics',
  handler(async (_req, res) => {
    ok(res, await buildAdminAnalytics());
  }),
);
