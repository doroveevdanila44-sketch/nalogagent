import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { readJson } from '@/lib/auth/request';
import { json } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { docRoute } from '@/lib/documents/http';
import { deleteDocuments } from '@/lib/documents/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(50) });

/**
 * Удалить черновики (один или выбранные в списке). Мягкое удаление: сутки их можно вернуть
 * (/api/documents/restore), потом они стираются вместе с версиями и комментариями. Документы не в
 * статусе «Черновик» не удаляются, ответ 409.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return docRoute(req, 'documents/delete', { mutating: true }, async ({ userId }) => {
    const body = await readJson(req, Body);
    const ids = await deleteDocuments(getDb(), { userId, ids: body.ids, nowMs: Date.now() });
    return json({ ids });
  });
}
