import { prisma, type User, type Workspace } from '@leadwave/db';

/**
 * Every signed-in user needs a workspace before they can do anything, so it is
 * created on first sign-in rather than as a separate onboarding step. If the
 * user was invited to someone else's workspace, that membership is accepted
 * instead of creating a second one.
 */
export async function ensureWorkspaceFor(user: User): Promise<Workspace> {
  const existing = await prisma.workspaceMember.findFirst({
    where: { userId: user.id },
    include: { workspace: true },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) return existing.workspace;

  const invite = await prisma.invite.findFirst({
    where: {
      email: user.email,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { workspace: true },
    orderBy: { createdAt: 'desc' },
  });

  if (invite) {
    await prisma.$transaction([
      prisma.workspaceMember.create({
        data: { workspaceId: invite.workspaceId, userId: user.id, role: invite.role },
      }),
      prisma.invite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      }),
    ]);
    return invite.workspace;
  }

  return prisma.workspace.create({
    data: {
      name: defaultWorkspaceName(user),
      members: { create: { userId: user.id, role: 'admin' } },
      subscription: { create: { plan: 'free', provider: 'manual' } },
    },
  });
}

function defaultWorkspaceName(user: User): string {
  const first = user.name?.trim().split(/\s+/)[0];
  if (first) return `${first}'s workspace`;
  const handle = user.email.split('@')[0];
  return handle ? `${handle}'s workspace` : 'My workspace';
}
