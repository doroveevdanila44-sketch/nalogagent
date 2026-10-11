import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { readJson } from '@/lib/auth/request';
import { json } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { docRoute, type IdContext } from '@/lib/documents/http';
import { simulateReply } from '@/lib/documents/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ kind: z.enum(['comment', 'remark', 'approve']) });

/**
 * Демо: имитация ответа бухгалтера (комментарий, замечание или согласование), чтобы заказчик
 * прошёл весь процесс. Ответ помечен «Демо» в комментарии и в ленте.
 */
export async function POST(req: NextRequest, ctx: IdContext): Promise<NextResponse> {
  return docRoute(req, 'documents/simulate', { mutating: true }, async ({ userId }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, Body);
    const status = await simulateReply(getDb(), { userId, id, kind: body.kind, nowMs: Date.now() });
    return json({ status, demo: true });
  });
}
