import { Router } from 'express';
import { messengerWebhookRouter } from './messenger.js';
import { handleBillingWebhook } from '../routes/billing.js';

/** Webhook receivers. These authenticate by signature, never by session. */
export const webhookRouter: Router = Router();

webhookRouter.use('/messenger', messengerWebhookRouter);
// Meta points a single callback at the app, so accept the bare path too.
webhookRouter.use('/meta', messengerWebhookRouter);

// Billing provider callbacks, verified by signature over the raw body.
webhookRouter.post('/billing', handleBillingWebhook);
