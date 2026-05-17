import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// POST /api/conversations/draft
// Creates an empty Conversation row with status='draft' so the user can
// edit it inline in the thread view (recipient picker, channel, body) like
// any other thread. Returns the new id so the UI can navigate to it.
//
// Drafts are completely hidden from every non-drafts filter — see filter.ts.
export async function POST() {
  // Local-only id, picked so it sorts to the top by lastMessageAt and is
  // obviously a draft from the prefix. Replaced when send succeeds (the
  // real LinkedIn URN takes over via background sync).
  const id = `draft:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  const conv = await prisma.conversation.create({
    data: {
      id,
      source: 'linkedin', // tentative; user picks channel before send
      participants: '[]',
      lastMessage: '',
      lastMessageAt: now,
      status: 'draft',
      unreadCount: 0,
      isStarred: false,
      labels: '[]',
      notes: '',
    },
  });
  return NextResponse.json({ conversation: conv }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
