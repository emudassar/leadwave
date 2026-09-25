/**
 * Development seed.
 *
 * Builds one workspace that looks like it has been running for a fortnight: a
 * connected Page, three published automations, a couple of hundred contacts and
 * the messages, clicks, leads and AI receipts they produced. The point is that
 * every screen in the dashboard has something real to render — an empty state
 * tells you nothing about whether a chart, a filter or a cursor actually works.
 *
 * Idempotent: it clears the seeded workspace first, so running it twice is
 * exactly the same as running it once.
 *
 *   pnpm db:seed
 */
import {
  PrismaClient,
  type Prisma,
  type Contact,
  type ConnectedAccount,
} from '@prisma/client';
import { createCipheriv, randomBytes, createHash } from 'node:crypto';

const prisma = new PrismaClient();

const SEED_EMAIL = process.env.SEED_EMAIL ?? 'mudassar63663@gmail.com';
const PAGE_ID = '100000000000001';

// ─── Small helpers ───────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Deterministic pseudo-randomness, so two runs produce the same-shaped data. */
let seedState = 42;
function rand(): number {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const int = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));
const ago = (ms: number): Date => new Date(Date.now() - ms);

/**
 * Mirrors `apps/api/src/lib/crypto.ts`. The seed cannot import from the API
 * package (it would drag in the whole env schema), so the format is repeated
 * here — `v1:<iv>:<tag>:<ciphertext>`, all base64url.
 */
function encrypt(plaintext: string): string {
  const key = Buffer.from(
    process.env.ENCRYPTION_KEY ?? createHash('sha256').update('leadwave-seed').digest('hex'),
    'hex',
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

const FIRST_NAMES = [
  'Ayesha', 'Bilal', 'Sana', 'Hamza', 'Zara', 'Omar', 'Mariam', 'Danish', 'Hira', 'Faisal',
  'Emily', 'Jordan', 'Priya', 'Marcus', 'Chloe', 'Diego', 'Aisha', 'Noah', 'Leila', 'Tom',
  'Fatima', 'Ravi', 'Sophie', 'Yusuf', 'Anna', 'Kabir', 'Nadia', 'Liam', 'Rida', 'Owen',
];
const LAST_NAMES = [
  'Khan', 'Ahmed', 'Sheikh', 'Malik', 'Iqbal', 'Rossi', 'Chen', 'Silva', 'Okafor', 'Novak',
  'Hassan', 'Patel', 'Dubois', 'Meyer', 'Costa', 'Nguyen', 'Farooq', 'Baig', 'Shah', 'Riaz',
];

// ─── Automation definitions ──────────────────────────────────────────────────

const commentAutomation = {
  name: 'Comment "PRICE" → send the menu',
  trigger: {
    type: 'comment',
    scope: { kind: 'all_posts' },
    keywords: { mode: 'contains', keywords: ['price', 'pricing', 'menu', 'cost'], excludeKeywords: [] },
    publicReply: {
      enabled: true,
      variants: ['Just sent it your way 📩', 'Check your inbox ✨', 'Sent! Have a look at your messages 💬'],
    },
    ignoreOwnComments: true,
    oncePerCommenterPerPost: true,
  },
  steps: [
    {
      id: 'step_hello',
      type: 'send_message',
      text: "Hey {{first_name}} 👋 thanks for commenting!\n\nHere's our full price list — everything's on one page.",
      buttons: [{ kind: 'url', label: 'See the prices', url: 'https://example.com/pricing', shortLinkId: null }],
      quickReplies: [],
      imageUrl: null,
    },
    {
      id: 'step_gate',
      type: 'follow_gate',
      gateText: 'One quick thing — follow the Page so you catch the next drop, then tap below 👇',
      unlockButtonLabel: 'I followed ✅',
      pageUrl: 'https://facebook.com/leadwavedemo',
      skipForKnownFollowers: true,
      timeoutHours: 20,
      onTimeout: { action: 'unlock' },
    },
    {
      id: 'step_email',
      type: 'ask_email',
      prompt: 'Want the 10% first-order code? Drop your email and I\'ll send it over.',
      useNativeQuickReply: true,
      successText: 'Got it — code is on its way 🎉',
      retryText: "Hmm, that doesn't look like an email. Mind trying again?",
      maxRetries: 1,
      continueOnFailure: true,
    },
    {
      id: 'step_nudge',
      type: 'follow_up',
      delayMinutes: 90,
      text: "Still thinking it over? Here's that link again 👇",
      resendButtons: true,
      buttons: [],
    },
  ],
} satisfies Record<string, unknown>;

const dmAutomation = {
  name: 'DM "SHIP" → shipping answer',
  trigger: {
    type: 'dm_keyword',
    keywords: { mode: 'contains', keywords: ['ship', 'shipping', 'delivery', 'deliver'], excludeKeywords: ['shipment lost'] },
    firstMessageOnly: false,
  },
  steps: [
    {
      id: 'step_ship',
      type: 'send_message',
      text: 'We ship nationwide 🚚\n\n• Karachi, Lahore, Islamabad — 1–2 days\n• Everywhere else — 3–5 days\n• Free over Rs 3,000',
      buttons: [{ kind: 'url', label: 'Track an order', url: 'https://example.com/track', shortLinkId: null }],
      quickReplies: [
        { label: 'Talk to a human', payload: 'HUMAN' },
        { label: 'See the catalogue', payload: 'CATALOGUE' },
      ],
      imageUrl: null,
    },
  ],
} satisfies Record<string, unknown>;

const carouselAutomation = {
  name: 'Story reply → best sellers',
  trigger: {
    type: 'story_reply',
    keywords: { mode: 'any', keywords: [], excludeKeywords: [] },
    storyIds: null,
  },
  steps: [
    {
      id: 'step_intro',
      type: 'send_message',
      text: 'Thanks for replying to the story {{first_name}}! Here are the three everyone\'s buying right now 👇',
      buttons: [],
      quickReplies: [],
      imageUrl: null,
    },
    {
      id: 'step_cards',
      type: 'product_carousel',
      introText: '',
      cards: [
        {
          id: 'card_hoodie',
          title: 'Oversized hoodie',
          subtitle: 'Rs 4,200 · free shipping',
          imageUrl: 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=600',
          buttons: [{ kind: 'url', label: 'Buy now', url: 'https://example.com/hoodie', shortLinkId: null }],
        },
        {
          id: 'card_tee',
          title: 'Heavyweight tee',
          subtitle: 'Rs 1,900 · 4 colours',
          imageUrl: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=600',
          buttons: [{ kind: 'url', label: 'Buy now', url: 'https://example.com/tee', shortLinkId: null }],
        },
        {
          id: 'card_cap',
          title: 'Corduroy cap',
          subtitle: 'Rs 1,400 · almost gone',
          imageUrl: 'https://images.unsplash.com/photo-1588850561407-ed78c282e89b?w=600',
          buttons: [{ kind: 'url', label: 'Buy now', url: 'https://example.com/cap', shortLinkId: null }],
        },
      ],
    },
  ],
} satisfies Record<string, unknown>;

// ─── Seed ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('→ clearing previous seed data');
  const existing = await prisma.user.findUnique({
    where: { email: SEED_EMAIL },
    include: { memberships: true },
  });
  if (existing) {
    await prisma.workspace.deleteMany({
      where: { id: { in: existing.memberships.map((m) => m.workspaceId) } },
    });
    await prisma.user.delete({ where: { id: existing.id } });
  }

  console.log('→ user + workspace');
  const user = await prisma.user.create({
    data: {
      email: SEED_EMAIL,
      name: 'Mudassar',
      avatarUrl: 'https://api.dicebear.com/9.x/initials/svg?seed=Mudassar',
      isAdmin: true,
      lastSeenAt: new Date(),
    },
  });

  const teammate = await prisma.user.upsert({
    where: { email: 'sana@leadwave.test' },
    update: {},
    create: {
      email: 'sana@leadwave.test',
      name: 'Sana Riaz',
      avatarUrl: 'https://api.dicebear.com/9.x/initials/svg?seed=Sana',
    },
  });

  const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 1);

  const workspace = await prisma.workspace.create({
    data: {
      name: 'Leadwave Demo Co.',
      timezone: 'Asia/Karachi',
      // Growth so the AI screens are unlocked and worth looking at.
      plan: 'growth',
      persona: 'small_business',
      onboardedAt: ago(14 * DAY),
      members: {
        create: [
          { userId: user.id, role: 'admin' },
          { userId: teammate.id, role: 'manager' },
        ],
      },
      subscription: {
        create: {
          plan: 'growth',
          provider: 'manual',
          status: 'active',
          interval: 'month',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
      },
      usageCounters: {
        create: {
          periodStart,
          periodEnd,
          messagesSent: 1_284,
          aiCreditsUsed: 213,
          leadsCaptured: 46,
        },
      },
    },
  });

  console.log('→ connected Page');
  const account = await prisma.connectedAccount.create({
    data: {
      workspaceId: workspace.id,
      pageId: PAGE_ID,
      pageName: 'Leadwave Demo Store',
      pageUsername: 'leadwavedemo',
      pagePictureUrl: 'https://api.dicebear.com/9.x/shapes/svg?seed=leadwave',
      pageUrl: 'https://facebook.com/leadwavedemo',
      // Not a real token — the Graph client will fail loudly if anything tries
      // to use it, which is what you want from seed data.
      accessTokenCipher: encrypt('SEED-NOT-A-REAL-PAGE-TOKEN'),
      tokenExpiresAt: new Date(Date.now() + 55 * DAY),
      grantedScopes: [
        'pages_show_list',
        'pages_messaging',
        'pages_manage_metadata',
        'pages_read_engagement',
        'pages_manage_engagement',
      ],
      status: 'active',
      webhookSubscribedAt: ago(14 * DAY),
      color: '#157A70',
      greetingText: 'Hi {{first_name}}! Ask us anything — we usually reply in a minute.',
    },
  });

  console.log('→ automations');
  const comment = await prisma.automation.create({
    data: {
      connectedAccountId: account.id,
      name: commentAutomation.name,
      triggerType: 'comment',
      status: 'live',
      definition: commentAutomation as unknown as Prisma.InputJsonValue,
      keywords: ['price', 'pricing', 'menu', 'cost'],
      watchesAllPosts: true,
      publishedAt: ago(13 * DAY),
      lastTriggeredAt: ago(2 * HOUR),
    },
  });

  const dm = await prisma.automation.create({
    data: {
      connectedAccountId: account.id,
      name: dmAutomation.name,
      triggerType: 'dm_keyword',
      status: 'live',
      definition: dmAutomation as unknown as Prisma.InputJsonValue,
      keywords: ['ship', 'shipping', 'delivery', 'deliver'],
      publishedAt: ago(9 * DAY),
      lastTriggeredAt: ago(5 * HOUR),
    },
  });

  const carousel = await prisma.automation.create({
    data: {
      connectedAccountId: account.id,
      name: carouselAutomation.name,
      triggerType: 'story_reply',
      status: 'paused',
      definition: carouselAutomation as unknown as Prisma.InputJsonValue,
      publishedAt: ago(6 * DAY),
      lastTriggeredAt: ago(2 * DAY),
    },
  });

  await prisma.automation.create({
    data: {
      connectedAccountId: account.id,
      name: 'Welcome message (draft)',
      triggerType: 'welcome',
      status: 'draft',
      definition: {
        name: 'Welcome message (draft)',
        trigger: { type: 'welcome' },
        steps: [
          {
            id: 'step_welcome',
            type: 'send_message',
            text: "Welcome to {{page_name}} 👋 What can I help you find?",
            buttons: [],
            quickReplies: [
              { label: 'Prices', payload: 'PRICES' },
              { label: 'Shipping', payload: 'SHIPPING' },
            ],
            imageUrl: null,
          },
        ],
      } as unknown as Prisma.InputJsonValue,
    },
  });

  console.log('→ tracked links');
  const links = await Promise.all(
    [
      { slug: 'pr1c3', targetUrl: 'https://example.com/pricing', automationId: comment.id, stepId: 'step_hello', buttonIndex: 0, cardId: null },
      { slug: 'trk01', targetUrl: 'https://example.com/track', automationId: dm.id, stepId: 'step_ship', buttonIndex: 0, cardId: null },
      { slug: 'hoodie', targetUrl: 'https://example.com/hoodie', automationId: carousel.id, stepId: 'step_cards', buttonIndex: 0, cardId: 'card_hoodie' },
      { slug: 'tee', targetUrl: 'https://example.com/tee', automationId: carousel.id, stepId: 'step_cards', buttonIndex: 0, cardId: 'card_tee' },
      { slug: 'cap', targetUrl: 'https://example.com/cap', automationId: carousel.id, stepId: 'step_cards', buttonIndex: 0, cardId: 'card_cap' },
    ].map((l) =>
      prisma.shortLink.create({ data: { ...l, connectedAccountId: account.id } }),
    ),
  );

  console.log('→ labels & saved replies');
  const [hotLabel, vipLabel] = await Promise.all([
    prisma.label.create({ data: { connectedAccountId: account.id, name: 'Hot lead', color: '#F59E0B' } }),
    prisma.label.create({ data: { connectedAccountId: account.id, name: 'VIP', color: '#8B5CF6' } }),
  ]);
  await prisma.savedReply.createMany({
    data: [
      { connectedAccountId: account.id, title: 'Shipping times', shortcut: '/shipping', body: 'We ship in 1–2 days to major cities, 3–5 days elsewhere. Free over Rs 3,000!', usageCount: 34 },
      { connectedAccountId: account.id, title: 'Size guide', shortcut: '/sizes', body: 'Our sizes run true to fit. If you\'re between two, take the larger one — here\'s the full chart: https://example.com/sizes', usageCount: 21 },
      { connectedAccountId: account.id, title: 'Returns', shortcut: '/returns', body: '7-day returns, no questions asked, as long as the tags are still on 🙂', usageCount: 12 },
    ],
  });

  console.log('→ contacts, conversations, messages');
  const contacts: Contact[] = [];
  const CONTACT_COUNT = 140;

  for (let i = 0; i < CONTACT_COUNT; i += 1) {
    const firstName = pick(FIRST_NAMES);
    const lastName = pick(LAST_NAMES);
    const firstSeenAt = ago(int(1, 14) * DAY + int(0, 23) * HOUR);
    // A third of the list is still inside Messenger's 24h window.
    const lastInboundAt = rand() < 0.35 ? ago(int(1, 20) * HOUR) : ago(int(2, 12) * DAY);

    const contact = await prisma.contact.create({
      data: {
        connectedAccountId: account.id,
        psid: `psid_${100000 + i}`,
        firstName,
        lastName,
        profilePicUrl: `https://api.dicebear.com/9.x/initials/svg?seed=${firstName}${lastName}`,
        locale: pick(['en_US', 'en_GB', 'ur_PK']),
        timezoneOffset: 5,
        firstSeenAt,
        lastInboundAt,
        lastOutboundAt: new Date(lastInboundAt.getTime() + int(2, 90) * 1000),
        lastHumanReplyAt: rand() < 0.15 ? ago(int(1, 5) * DAY) : null,
        followConfirmedAt: rand() < 0.4 ? new Date(firstSeenAt.getTime() + 4 * 60 * 1000) : null,
        optedOutAt: rand() < 0.03 ? ago(int(1, 6) * DAY) : null,
      },
    });
    contacts.push(contact);
  }

  // Full threads for the first 40; the rest just exist as contacts, which is
  // what a real account looks like after a viral post.
  const threaded = contacts.slice(0, 40);
  for (const [index, contact] of threaded.entries()) {
    const startedAt = contact.lastInboundAt ?? ago(2 * DAY);
    const conversation = await prisma.conversation.create({
      data: {
        connectedAccountId: account.id,
        contactId: contact.id,
        lastMessageAt: startedAt,
        unreadCount: rand() < 0.3 ? int(1, 3) : 0,
        isPinned: index < 2,
        isArchived: index > 35,
        hasAiActivity: rand() < 0.45,
      },
    });

    const inboundText = pick([
      'price?', 'how much is the hoodie', 'do you ship to Multan?',
      'is this still available', 'PRICE', 'can I get the menu',
      'shipping cost?', 'hey! saw your reel', 'do you have it in black?',
    ]);

    const messages: Prisma.MessageCreateManyInput[] = [
      {
        conversationId: conversation.id,
        direction: 'inbound',
        status: 'read',
        source: 'contact',
        text: inboundText,
        createdAt: startedAt,
        sentAt: startedAt,
      },
      {
        conversationId: conversation.id,
        direction: 'outbound',
        status: 'delivered',
        source: 'automation',
        automationId: comment.id,
        text: `Hey ${contact.firstName} 👋 thanks for commenting!\n\nHere's our full price list — everything's on one page.`,
        payload: {
          type: 'button_template',
          buttons: [{ type: 'web_url', title: 'See the prices', url: 'http://localhost:4000/r/pr1c3' }],
        },
        createdAt: new Date(startedAt.getTime() + 3_000),
        sentAt: new Date(startedAt.getTime() + 3_000),
      },
    ];

    if (conversation.hasAiActivity) {
      messages.push(
        {
          conversationId: conversation.id,
          direction: 'inbound',
          status: 'read',
          source: 'contact',
          text: pick(['does it run big?', 'whats the return policy', 'any discount for 2?']),
          createdAt: new Date(startedAt.getTime() + 6 * 60_000),
          sentAt: new Date(startedAt.getTime() + 6 * 60_000),
        },
        {
          conversationId: conversation.id,
          direction: 'outbound',
          status: 'delivered',
          source: 'ai',
          isAiGenerated: true,
          text: pick([
            'It fits true to size — if you\'re between two, take the larger one 🙂',
            'Returns are open for 7 days as long as the tags are on!',
            'We do 10% off when you take two — want me to send the link?',
          ]),
          createdAt: new Date(startedAt.getTime() + 6 * 60_000 + 4_000),
          sentAt: new Date(startedAt.getTime() + 6 * 60_000 + 4_000),
        },
      );
    }

    if (index === 3) {
      // One scheduled message, so the inbox's scheduled state is visible.
      messages.push({
        conversationId: conversation.id,
        direction: 'outbound',
        status: 'scheduled',
        source: 'scheduled',
        senderId: user.id,
        text: 'Morning! The restock lands today at 6pm — want me to hold one?',
        scheduledFor: new Date(Date.now() + 5 * HOUR),
        createdAt: new Date(),
      });
    }

    await prisma.message.createMany({ data: messages });

    const last = messages.at(-1)!;
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: last.createdAt as Date,
        lastMessagePreview: (last.text ?? '').slice(0, 120),
      },
    });

    if (index < 6) {
      await prisma.conversationLabel.create({
        data: { conversationId: conversation.id, labelId: index % 2 ? vipLabel.id : hotLabel.id },
      });
    }

    if (index < 3) {
      await prisma.contactNote.create({
        data: {
          contactId: contact.id,
          authorId: user.id,
          body: pick([
            'Asked about bulk pricing — worth a call.',
            'Repeat customer, third order this month.',
            'Wants the black colourway when it restocks.',
          ]),
        },
      });
    }
  }

  console.log('→ automation runs');
  for (const [index, contact] of contacts.slice(0, 90).entries()) {
    const automation = index % 3 === 0 ? dm : comment;
    const startedAt = contact.lastInboundAt ?? ago(DAY);
    const roll = rand();
    await prisma.automationRun.create({
      data: {
        automationId: automation.id,
        contactId: contact.id,
        status: roll < 0.7 ? 'completed' : roll < 0.85 ? 'waiting' : roll < 0.95 ? 'abandoned' : 'failed',
        stepIndex: int(0, 3),
        waitingFor: roll >= 0.7 && roll < 0.85 ? pick(['follow_gate', 'ask_email']) : null,
        waitingSince: roll >= 0.7 && roll < 0.85 ? startedAt : null,
        sourceType: automation.triggerType,
        sourcePostId: automation.id === comment.id ? `${PAGE_ID}_post_${int(1, 5)}` : null,
        sourceCommentId: automation.id === comment.id ? `${PAGE_ID}_cmt_${index}` : null,
        startedAt,
        completedAt: roll < 0.7 ? new Date(startedAt.getTime() + int(30, 900) * 1000) : null,
        error: roll >= 0.95 ? 'Graph API error 10: outside the 24-hour window.' : null,
      },
    });
  }

  console.log('→ link clicks');
  for (const link of links) {
    const clicks = link.slug === 'pr1c3' ? 64 : int(12, 40);
    const rows: Prisma.LinkClickCreateManyInput[] = [];
    const seen = new Set<string>();
    // Draw from a slice of the list, so a few people click more than once and
    // unique clickers stays below the number of triggers — as it does in life.
    const pool = contacts.slice(0, Math.max(8, Math.round(clicks * 0.6)));
    for (let i = 0; i < clicks; i += 1) {
      const contact = pick(pool);
      const isUnique = !seen.has(contact.id);
      seen.add(contact.id);
      rows.push({
        shortLinkId: link.id,
        contactId: contact.id,
        isUnique,
        device: pick(['mobile', 'mobile', 'mobile', 'desktop', 'tablet']),
        country: pick(['PK', 'PK', 'US', 'GB', 'AE']),
        visitorHash: createHash('sha256').update(contact.id).digest('hex').slice(0, 32),
        createdAt: ago(int(0, 13) * DAY + int(0, 23) * HOUR),
      });
    }
    await prisma.linkClick.createMany({ data: rows });
    await prisma.shortLink.update({
      where: { id: link.id },
      data: { clickCount: rows.length, uniqueClickCount: seen.size },
    });
  }

  console.log('→ leads');
  const leadRows: Prisma.LeadCreateManyInput[] = [];
  for (const contact of contacts.slice(0, 46)) {
    const handle = `${contact.firstName}.${contact.lastName}`.toLowerCase();
    leadRows.push({
      connectedAccountId: account.id,
      contactId: contact.id,
      type: 'email',
      value: `${handle}@example.com`,
      rawValue: `${handle}@example.com `,
      source: 'automation',
      automationId: comment.id,
      createdAt: ago(int(0, 13) * DAY),
    });
  }
  for (const contact of contacts.slice(46, 58)) {
    leadRows.push({
      connectedAccountId: account.id,
      contactId: contact.id,
      type: 'phone',
      value: `+9230${int(10000000, 99999999)}`,
      source: 'automation',
      automationId: dm.id,
      createdAt: ago(int(0, 10) * DAY),
    });
  }
  await prisma.lead.createMany({ data: leadRows, skipDuplicates: true });

  console.log('→ comment ledger');
  await prisma.commentReply.createMany({
    data: contacts.slice(0, 30).map((contact, i) => ({
      connectedAccountId: account.id,
      commentId: `${PAGE_ID}_cmt_${i}`,
      postId: `${PAGE_ID}_post_${(i % 5) + 1}`,
      commenterId: contact.psid,
      contactId: contact.id,
      kind: 'private_reply' as const,
      automationId: comment.id,
      commentText: pick(['price?', 'PRICE', 'how much', 'menu please']),
      replyText: 'Just sent it your way 📩',
      commentCreatedAt: ago(int(0, 12) * DAY),
    })),
    skipDuplicates: true,
  });

  console.log('→ LeadWave AI');
  await prisma.aiSettings.create({
    data: {
      connectedAccountId: account.id,
      repliesEnabled: true,
      commentsEnabled: true,
      role: 'Friendly shop assistant for a Karachi streetwear label',
      brandVoice:
        'Warm and quick. Short sentences, one emoji at most, never pushy. Sound like a real person behind the counter, not a brochure. If you do not know something, say so and offer to check.',
      guardrails: [
        'Never promise a delivery date we have not confirmed.',
        'Never discount more than 10% without a human.',
        'Never share supplier or cost information.',
      ],
      languageMode: 'match_sender',
      commentScope: 'recent_posts',
    },
  });

  await prisma.aiKnowledgeSource.createMany({
    data: [
      {
        connectedAccountId: account.id,
        type: 'link',
        title: 'Shipping & returns',
        sourceUrl: 'https://example.com/shipping',
        content:
          'Orders ship within 24 hours on business days. Karachi, Lahore and Islamabad arrive in 1–2 days; everywhere else 3–5 days. Shipping is free over Rs 3,000, otherwise Rs 200. Returns are accepted within 7 days if the tags are attached; refunds land in 5–7 business days.',
        charCount: 320,
        lastScannedAt: ago(3 * DAY),
      },
      {
        connectedAccountId: account.id,
        type: 'text',
        title: 'Sizing',
        content:
          'All pieces run true to size. The oversized hoodie is deliberately one size roomy. If a customer is between two sizes, recommend the larger one. Sizes run XS to XXL; the cap is one size with an adjustable strap.',
        charCount: 210,
      },
      {
        connectedAccountId: account.id,
        type: 'interview',
        title: 'About the brand',
        content:
          'Founded in 2023 in Karachi. Small-batch streetwear, printed locally. Two drops a year, plus restocks of the best sellers. The studio is open for pickups on Saturdays, 12–6pm, in DHA Phase 6.',
        charCount: 195,
      },
    ],
  });

  const shareGoal = await prisma.aiGoal.create({
    data: {
      connectedAccountId: account.id,
      type: 'share_link',
      status: 'live',
      config: { url: 'https://example.com/pricing', label: 'the price list' },
      attemptedCount: 118,
      successCount: 41,
    },
  });
  await prisma.aiGoal.create({
    data: {
      connectedAccountId: account.id,
      type: 'capture_lead',
      status: 'live',
      config: { field: 'email', prompt: 'Ask for an email to send the restock alert.' },
      attemptedCount: 76,
      successCount: 22,
    },
  });

  const aiEvents: Prisma.AiEventCreateManyInput[] = [];
  for (const [i, contact] of contacts.slice(0, 60).entries()) {
    const skipped = rand() < 0.28;
    aiEvents.push({
      connectedAccountId: account.id,
      contactId: contact.id,
      kind: skipped ? 'message_skip' : i % 4 === 0 ? 'comment_funnel' : 'message_reply',
      label: skipped ? pick(['spam', 'complaint', 'off_topic']) : pick(['question', 'buying_intent', 'small_talk']),
      skipReason: skipped ? pick(['no_knowledge', 'human_recently_replied', 'outside_window', 'muted']) : null,
      triggerText: pick(['does it run big?', 'whats the return policy', 'any discount for 2?', 'where are you located']),
      replyText: skipped ? null : 'It fits true to size — if you\'re between two, take the larger one 🙂',
      goalId: !skipped && i % 3 === 0 ? shareGoal.id : null,
      goalSucceededAt: !skipped && i % 6 === 0 ? ago(int(1, 9) * DAY) : null,
      creditsCharged: skipped ? 0 : 1,
      modelMeta: { model: 'gemini-2.5-flash', inputTokens: int(400, 1400), outputTokens: int(20, 90) },
      createdAt: ago(int(0, 13) * DAY + int(0, 23) * HOUR),
    });
  }
  await prisma.aiEvent.createMany({ data: aiEvents });

  await prisma.aiCreditLedger.createMany({
    data: [
      { workspaceId: workspace.id, delta: 1_000, reason: 'cycle_reset', note: 'Growth plan monthly allowance', createdAt: periodStart },
      { workspaceId: workspace.id, delta: -213, reason: 'message_reply', note: 'AI replies this cycle' },
      { workspaceId: workspace.id, delta: 100, reason: 'admin_grant', note: 'Launch bonus' },
    ],
  });

  console.log('→ link-in-bio');
  const bio = await prisma.bioPage.create({
    data: {
      workspaceId: workspace.id,
      handle: 'leadwavedemo',
      displayName: 'Leadwave Demo Store',
      bio: 'Small-batch streetwear from Karachi 🇵🇰 · Two drops a year · DM us anything',
      avatarUrl: 'https://api.dicebear.com/9.x/shapes/svg?seed=leadwave',
      theme: 'midnight',
      themeConfig: { accent: '#157A70', buttonShape: 'pill', font: 'geist' },
      isPublished: true,
      showBranding: false,
      seoTitle: 'Leadwave Demo Store — streetwear from Karachi',
      seoDescription: 'Shop the latest drop, check shipping, or message us directly.',
      viewCount: 2_480,
    },
  });

  const blocks = await Promise.all(
    [
      { type: 'header' as const, position: 0, title: 'Shop the new drop' },
      { type: 'link' as const, position: 1, title: 'Autumn drop — live now', subtitle: '12 pieces, limited run', url: 'https://example.com/drop', clickCount: 612 },
      { type: 'link' as const, position: 2, title: 'Best sellers', subtitle: 'The hoodie everyone asks about', url: 'https://example.com/best', clickCount: 388 },
      { type: 'email_capture' as const, position: 3, title: 'Get restock alerts', subtitle: 'We only email when something lands.', config: { buttonLabel: 'Notify me' } },
      { type: 'link' as const, position: 4, title: 'Size guide', url: 'https://example.com/sizes', clickCount: 154 },
      { type: 'socials' as const, position: 5, config: { links: [{ platform: 'facebook', url: 'https://facebook.com/leadwavedemo' }, { platform: 'instagram', url: 'https://instagram.com/leadwavedemo' }] } },
    ].map((block) =>
      prisma.bioBlock.create({ data: { ...block, bioPageId: bio.id } }),
    ),
  );

  // More views than clicks, which is the only order those two ever come in.
  await prisma.bioPageView.createMany({
    data: Array.from({ length: 2_600 }, () => ({
      bioPageId: bio.id,
      device: pick(['mobile', 'mobile', 'desktop']),
      country: pick(['PK', 'US', 'GB', 'AE']),
      referer: pick(['https://facebook.com/', 'https://instagram.com/', null]),
      createdAt: ago(int(0, 29) * DAY),
    })),
  });

  // Bio links are tracked exactly like DM buttons, so they need click rows too —
  // otherwise "unique people" reads zero next to a four-figure click count.
  const bioLinks = await prisma.shortLink.findMany({
    where: { bioBlockId: { in: blocks.map((b) => b.id) } },
  });
  for (const link of bioLinks) {
    const block = blocks.find((b) => b.id === link.bioBlockId);
    const clicks = block?.clickCount ?? 0;
    if (clicks === 0) continue;
    const visitors = Math.round(clicks * 0.72);
    await prisma.linkClick.createMany({
      data: Array.from({ length: clicks }, (_, i) => ({
        shortLinkId: link.id,
        isUnique: i < visitors,
        device: pick(['mobile', 'mobile', 'mobile', 'desktop']),
        country: pick(['PK', 'US', 'GB', 'AE']),
        visitorHash: createHash('sha256').update(`${link.id}:${i % visitors}`).digest('hex').slice(0, 32),
        createdAt: ago(int(0, 29) * DAY),
      })),
    });
    await prisma.shortLink.update({
      where: { id: link.id },
      data: { clickCount: clicks, uniqueClickCount: visitors },
    });
  }

  await prisma.lead.createMany({
    data: contacts.slice(58, 70).map((contact) => ({
      connectedAccountId: account.id,
      type: 'email' as const,
      value: `bio.${contact.firstName!.toLowerCase()}@example.com`,
      source: 'bio_page' as const,
      bioPageId: bio.id,
      createdAt: ago(int(0, 20) * DAY),
    })),
    skipDuplicates: true,
  });

  console.log('\n✓ Seeded.');
  console.log(`  user       ${user.email}`);
  console.log(`  workspace  ${workspace.name} (${workspace.plan})`);
  console.log(`  page       ${account.pageName}`);
  console.log(`  contacts   ${contacts.length}`);
  console.log(`  bio page   /u/${bio.handle} (${blocks.length} blocks)`);
  console.log('\n  Sign in with the dev bypass:');
  console.log('    curl -X POST http://localhost:4000/api/v1/auth/dev-login\n');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
