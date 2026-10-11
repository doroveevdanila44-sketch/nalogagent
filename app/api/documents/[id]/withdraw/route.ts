import { NextResponse, type NextRequest } from 'next/server';
import { json } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { docRoute, type IdContext } from '@/lib/documents/http';
import { withdrawDocument } from '@/lib/documents/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Отозвать документ: из проверки, из замечаний или из согласованных. */
export async function POST(req: NextRequest, ctx: IdContext): Promise<NextResponse> {
  return docRoute(req, 'documents/withdraw', { mutating: true }, async ({ userId }) => {
    const { id } = await ctx.params;
    await withdrawDocument(getDb(), { userId, id, nowMs: Date.now() });
    return json({ ok: true });
  });
}
