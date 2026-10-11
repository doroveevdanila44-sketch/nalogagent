import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { readJson } from '@/lib/auth/request';
import { json } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { docRoute, type IdContext } from '@/lib/documents/http';
import { submitDocument } from '@/lib/documents/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  recipientId: z.string().min(1).max(64),
  comment: z.string().trim().max(1000).default(''),
});

/** Отправить бухгалтеру или финансовому директору на проверку (демо: письмо не отправляется). */
export async function POST(req: NextRequest, ctx: IdContext): Promise<NextResponse> {
  return docRoute(req, 'documents/submit', { mutating: true }, async ({ userId }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, Body);
    await submitDocument(getDb(), { userId, id, recipientId: body.recipientId, comment: body.comment, nowMs: Date.now() });
    return json({ ok: true, demo: true });
  });
}
