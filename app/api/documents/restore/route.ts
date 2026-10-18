import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { readJson } from '@/lib/auth/request';
import { json } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { docRoute } from '@/lib/documents/http';
import { isUuid } from '@/lib/documents/ids';
import { restoreDocuments } from '@/lib/documents/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ ids: z.array(z.string().refine(isUuid)).min(1).max(50) });

/** Вернуть только что удалённые черновики («Отменить» в уведомлении), пока не прошли сутки. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return docRoute(req, 'documents/restore', { mutating: true }, async ({ userId }) => {
    const body = await readJson(req, Body);
    const ids = await restoreDocuments(getDb(), { userId, ids: body.ids, nowMs: Date.now() });
    return json({ ids });
  });
}
