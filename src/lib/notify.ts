// Server-side helper for creating in-app notifications. Used by import,
// classify, and job-change triggers. De-dupes within a short window per
// (kind + conversationId) so a chatty re-classify doesn't spam the bell.
//
// All callers should treat this as best-effort — never throw out of the
// caller if notification creation fails.

import { prisma } from '@/lib/db';

export type NotifyKind = 'new-message' | 'ai-signal' | 'job-change' | 'follow-up-due' | 'system';

export type NotifyInput = {
  kind: NotifyKind;
  title: string;
  body: string;
  conversationId?: string | null;
  contactId?: string | null;
  meta?: Record<string, unknown>;
};

// Suppress duplicate notifications for the same (kind, conversationId) within
// this window. Prevents repeat-fires when classify re-runs or imports re-process.
const DEDUPE_WINDOW_MS = 30 * 60 * 1000; // 30 min

export async function createNotification(input: NotifyInput): Promise<void> {
  try {
    if (input.conversationId) {
      const recent = await prisma.notification.findFirst({
        where: {
          kind: input.kind,
          conversationId: input.conversationId,
          createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
        },
        select: { id: true },
      });
      if (recent) return;
    }
    await prisma.notification.create({
      data: {
        kind: input.kind,
        title: input.title,
        body: input.body,
        conversationId: input.conversationId ?? null,
        contactId: input.contactId ?? null,
        meta: input.meta ? JSON.stringify(input.meta) : null,
      },
    });
  } catch {
    // Never propagate
  }
}
