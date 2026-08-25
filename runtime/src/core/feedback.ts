/**
 * In-app feedback capture (design-partner program, GRAND_PRODUCT §7.4).
 *
 * A signed-in member submits free-text feedback (bug/idea/general) from the
 * dashboard widget. It's persisted (for the operator admin list) and
 * fire-and-forget emailed to the operator (ADMIN_EMAIL, the same identity
 * used for the bootstrap-admin anti-lockout seed — see user-auth.ts) via the
 * shared mail transport. Deliberately lightweight — no reply thread, no
 * status workflow beyond new/reviewed; the minimum viable loop for an early
 * design-partner cohort to get feedback to the operator.
 */
import crypto from 'node:crypto';
import { FeedbackModel, type FeedbackCategory, type IFeedback } from '../shared/db.js';
import { AuthError } from './tenant-context.js';
import { sendMail } from '../shared/mailer.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'feedback' });

const CATEGORIES: ReadonlySet<FeedbackCategory> = new Set(['bug', 'idea', 'general']);
const MAX_MESSAGE_LEN = 4000;

export interface SubmitFeedbackInput {
  tenantId: string;
  userId: string;
  email: string;
  category?: string;
  message: string;
  page?: string;
}

export interface FeedbackView {
  feedbackId: string;
  tenantId: string;
  userId: string;
  email: string;
  category: FeedbackCategory;
  message: string;
  page?: string;
  status: string;
  createdAt?: Date;
}

function toView(doc: IFeedback): FeedbackView {
  return {
    feedbackId: doc.feedbackId,
    tenantId: doc.tenantId,
    userId: doc.userId,
    email: doc.email,
    category: doc.category,
    message: doc.message,
    page: doc.page,
    status: doc.status,
    createdAt: doc.createdAt,
  };
}

export async function submitFeedback(input: SubmitFeedbackInput): Promise<FeedbackView> {
  const message = input.message?.trim() ?? '';
  if (!message) throw new AuthError('message is required', 400, 'BAD_REQUEST');
  if (message.length > MAX_MESSAGE_LEN) {
    throw new AuthError(`message must be ${MAX_MESSAGE_LEN} characters or fewer`, 400, 'BAD_REQUEST');
  }
  const category: FeedbackCategory = CATEGORIES.has(input.category as FeedbackCategory)
    ? (input.category as FeedbackCategory)
    : 'general';

  const doc = await FeedbackModel.create({
    feedbackId: `fb_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    tenantId: input.tenantId,
    userId: input.userId,
    email: input.email,
    category,
    message,
    page: input.page,
    status: 'new',
  });

  log.info({ tenantId: input.tenantId, feedbackId: doc.feedbackId, category }, 'feedback submitted');

  // Fire-and-forget operator notification — never block/fail the submission
  // on mail delivery (same posture as email-verification/lifecycle emails).
  // Console-transport fallback means a single-operator self-host still sees
  // it (in the gateway log) even with no SMTP configured.
  const operatorEmail = process.env.ADMIN_EMAIL?.trim();
  if (operatorEmail) {
    void sendMail({
      to: operatorEmail,
      subject: `[myai feedback] ${category} — ${input.tenantId}`,
      text: [
        `New ${category} feedback from ${input.email} (tenant ${input.tenantId}):`,
        '',
        message,
        '',
        input.page ? `Page: ${input.page}` : undefined,
        `Feedback ID: ${doc.feedbackId}`,
      ].filter(Boolean).join('\n'),
    }).catch((err) => log.error({ err, feedbackId: doc.feedbackId }, 'operator feedback email failed'));
  }

  return toView(doc as IFeedback);
}

export async function listFeedback(): Promise<FeedbackView[]> {
  const rows = await FeedbackModel.find({}).sort({ createdAt: -1 }).limit(200).lean<IFeedback[]>();
  return rows.map(toView);
}
