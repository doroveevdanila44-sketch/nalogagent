import { NextResponse, type NextRequest } from 'next/server';
import { json } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { docRoute, type IdContext } from '@/lib/documents/http';
import { getDocument } from '@/lib/documents/service';
import { getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Документ с предпросмотром, недостающими полями, версиями, комментариями и историей. ?version=N. */
export async function GET(req: NextRequest, ctx: IdContext): Promise<NextResponse> {
  return docRoute(req, 'documents/get', { mutating: false }, async ({ userId }) => {
    const { id } = await ctx.params;
    const v = Number(req.nextUrl.searchParams.get('version'));
    const detail = await getDocument(getDb(), {
      userId,
      id,
      version: Number.isInteger(v) && v > 0 ? v : null,
      tz: getEnv().appTz,
    });
    return json(detail);
  });
}
