import type { NextFunction, Request, Response } from 'express';
import {
  prisma,
  type ConnectedAccount,
  type Workspace,
  type WorkspaceRole,
} from '@leadwave/db';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';

/**
 * Workspace resolution and per-Page scoping.
 *
 * Nearly every resource in LeadWave belongs to a ConnectedAccount (a Facebook
 * Page), which belongs to a Workspace. These helpers make that boundary
 * something a route cannot forget to check: a handler either has
 * `req.connectedAccount` because the middleware verified membership, or it has
 * nothing.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      workspace?: Workspace;
      workspaceRole?: WorkspaceRole;
      connectedAccount?: ConnectedAccount;
    }
  }
}

const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 0, manager: 1, admin: 2 };

/**
 * Loads the caller's workspace. A user has exactly one workspace today; the
 * membership table is already in place for when that changes.
 */
export async function attachWorkspace(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) return next(unauthorized());

    const membership = await prisma.workspaceMember.findFirst({
      where: { userId: req.user.id },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!membership) {
      return next(notFound('No workspace yet. Finish onboarding first.'));
    }

    req.workspace = membership.workspace;
    req.workspaceRole = membership.role;
    next();
  } catch (err) {
    next(err);
  }
}

/** Blocks anyone below `minimum`. Viewers can read; managers can act. */
export function requireRole(minimum: WorkspaceRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.workspaceRole;
    if (!role) return next(unauthorized());
    if (ROLE_RANK[role] < ROLE_RANK[minimum]) {
      return next(forbidden(`This needs ${minimum} access.`));
    }
    next();
  };
}

/**
 * Resolves `?connectedAccountId=` and verifies it belongs to the caller's
 * workspace. This is the check that stops one workspace reading another's
 * Page data by guessing an id.
 */
export async function attachConnectedAccount(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.workspace) return next(unauthorized());

    const id =
      (req.query.connectedAccountId as string | undefined) ??
      (typeof req.body === 'object' && req.body !== null
        ? ((req.body as Record<string, unknown>).connectedAccountId as string | undefined)
        : undefined);

    if (!id) {
      return next(notFound('Pick a Facebook Page first.'));
    }

    const account = await prisma.connectedAccount.findFirst({
      where: { id, workspaceId: req.workspace.id },
    });

    if (!account) return next(notFound('That Page is not connected to this workspace.'));

    req.connectedAccount = account;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Loads a ConnectedAccount by id with the same ownership check, for handlers
 * that take the id in the path rather than the query.
 */
export async function loadAccountOrThrow(
  workspaceId: string,
  connectedAccountId: string,
): Promise<ConnectedAccount> {
  const account = await prisma.connectedAccount.findFirst({
    where: { id: connectedAccountId, workspaceId },
  });
  if (!account) throw notFound('That Page is not connected to this workspace.');
  return account;
}
