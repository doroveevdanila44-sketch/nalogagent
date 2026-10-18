import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { BodyError, readJson } from '@/lib/auth/request';
import { failure, json, requireApiAuth } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { listChecks, setCheck } from '@/lib/provenance/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Subject = z.string().min(1).max(500).refine((s) => !s.includes('\u0000'));

const Body = z.object({
  subject: Subject,
  item: z.string().min(1).max(160),
  checked: z.boolean(),
  /** Итог расчёта на момент отметки, строкой */
  amount: z.string().max(40).nullable().default(null),
});

/** Отметки «сверил» по расчёту: ?subject=... */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: false });
    if (!gate.ok) return gate.res;
    const subject = Subject.safeParse(req.nextUrl.searchParams.get('subject'));
    if (!subject.success) return json({ error: 'Некорректный запрос', code: 'invalid' }, 400);
    const marks = await listChecks(getDb(), { userId: gate.auth.userId, subject: subject.data });
    return json({ marks });
  } catch (e) {
    return failure('checks/list', e);
  }
}

/** Поставить или снять отметку: пишется в таблицу checks (кто, что, когда). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: true });
    if (!gate.ok) return gate.res;
    const body = await readJson(req, Body);
    const mark = await setCheck(getDb(), { userId: gate.auth.userId, ...body });
    return json({ mark });
  } catch (e) {
    if (e instanceof BodyError) return json({ error: 'Некорректный запрос', code: 'invalid' }, 400);
    return failure('checks/set', e);
  }
}
