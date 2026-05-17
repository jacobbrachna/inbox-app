import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { requireAnthropic, MODELS } from '@/lib/ai';

const MAX_RAW_CHARS = 200_000;

// GET → { documents: [...] } — list all uploaded reference docs.
// rawText is omitted from the list (large); fetch a single doc via /api/documents/[id].
export async function GET() {
  const rows = await prisma.document.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      kind: true,
      summary: true,
      includeByDefault: true,
      sourceFilename: true,
      sourceMime: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return NextResponse.json({ documents: rows }, { headers: CORS });
}

// POST → upload a new doc. Body accepts either:
//   • { title, kind?, rawText, ... } — text/markdown content (or pasted text)
//   • { title, kind?, fileBase64, fileMime: 'application/pdf', ... } — PDF
// Runs Claude Haiku to summarize; stores the brief. For PDFs the file is
// sent to Claude as a document content block and discarded — only the
// summary persists.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const title = String(body?.title ?? '').trim();
    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400, headers: CORS });
    }

    const rawTextIn = typeof body?.rawText === 'string' ? body.rawText.trim() : '';
    const fileBase64 = typeof body?.fileBase64 === 'string' ? body.fileBase64 : '';
    const fileMime = typeof body?.fileMime === 'string' ? body.fileMime : '';
    if (!rawTextIn && !fileBase64) {
      return NextResponse.json({ error: 'rawText or fileBase64 is required' }, { status: 400, headers: CORS });
    }
    if (fileBase64 && fileMime !== 'application/pdf') {
      return NextResponse.json({ error: 'only application/pdf is supported for fileBase64' }, { status: 400, headers: CORS });
    }

    const kind = typeof body?.kind === 'string' && body.kind.trim() ? body.kind.trim() : 'other';
    const sourceFilename = typeof body?.sourceFilename === 'string' ? body.sourceFilename : null;
    const sourceMime = typeof body?.sourceMime === 'string' ? body.sourceMime : (fileBase64 ? fileMime : null);
    const includeByDefault = body?.includeByDefault !== false;

    const summarizeInstruction = [
      `Summarize the following ${kind} into a compact reference brief useful for personalizing sales outreach.`,
      '',
      'Include, where present:',
      '• Core thesis / positioning (1-2 sentences)',
      '• Specific painpoints, problems, or jobs-to-be-done addressed',
      '• Concrete proof points, stats, or differentiators (cite the exact numbers/claims)',
      '• Ideal customer characteristics or buyer titles, if mentioned',
      '',
      'Be specific and verbatim where possible — this brief will be used to ground AI-generated drafts, so vague paraphrasing makes it useless. Target ~400-600 tokens. No preamble. Output the brief only.',
      '',
      `Title: ${title}`,
    ].join('\n');

    const anthropic = await requireAnthropic();

    let summary = '';
    let storedRawText: string | null = null;
    let usage: unknown = null;

    // Short-circuit: imported winning-patterns docs ARE summaries. No Claude
    // call needed — store rawText as-is and use it directly as the summary.
    if (kind === 'winning-patterns' && rawTextIn) {
      const text = rawTextIn.slice(0, MAX_RAW_CHARS);
      storedRawText = text;
      summary = text;
    } else if (fileBase64) {
      const res = await anthropic.messages.create({
        model: MODELS.fast,
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } },
            { type: 'text', text: summarizeInstruction },
          ],
        }],
      });
      summary = res.content.filter((b) => b.type === 'text').map((b) => (b as { type: 'text'; text: string }).text).join('\n').trim();
      usage = res.usage;
    } else {
      storedRawText = rawTextIn.slice(0, MAX_RAW_CHARS);
      const res = await anthropic.messages.create({
        model: MODELS.fast,
        max_tokens: 1500,
        messages: [{ role: 'user', content: `${summarizeInstruction}\n\n---\n${storedRawText}` }],
      });
      summary = res.content.filter((b) => b.type === 'text').map((b) => (b as { type: 'text'; text: string }).text).join('\n').trim();
      usage = res.usage;
    }

    const doc = await prisma.document.create({
      data: {
        title,
        kind,
        rawText: storedRawText,
        summary: summary || null,
        includeByDefault,
        sourceFilename,
        sourceMime,
      },
      select: {
        id: true, title: true, kind: true, summary: true,
        includeByDefault: true, sourceFilename: true, sourceMime: true,
        createdAt: true, updatedAt: true,
      },
    });

    return NextResponse.json({ document: doc, usage }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    const status = msg.startsWith('NO_API_KEY') ? 401 : 500;
    return NextResponse.json({ error: msg }, { status, headers: CORS });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
