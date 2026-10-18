import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { BodyError, readJson } from '@/lib/auth/request';
import { failure, json, requireApiAuth } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { getEnv } from '@/lib/env';
import { TargetSchema } from '@/lib/provenance/schemas';
import {
  createReview,
  listPeople,
  listReviews,
  resolveTarget,
  TargetError,
} from '@/lib/provenance/server';
import { appNow } from '@/lib/clock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  target: TargetSchema,
  recipientId: z.string().min(1).max(64),
  comment: z.string().trim().max(1000).default(''),
});

/** Справочник получателей (вымышленный) и история запросов на проверку. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: false });
    if (!gate.ok) return gate.res;
    const db = getDb();
    const [recipients, requests] = await Promise.all([listPeople(db), listReviews(db, gate.auth.userId)]);
    return json({ people: recipients, requests, tz: getEnv().appTz });
  } catch (e) {
    return failure('reviews/list', e);
  }
}

/**
 * Передача расчёта специалисту (демо). Создаёт запись review_requests: снимок расчёта и Excel
 * сохраняются, статус «Отправлено на проверку». Реальной отправки нет, письмо никуда не уходит.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: true });
    if (!gate.ok) return gate.res;
    const body = await readJson(req, Body);
    const db = getDb();
    const snaps = await resolveTarget(db, {
      userId: gate.auth.userId,
      target: body.target,
      nowMs: appNow(),
      tz: getEnv().appTz,
    });
    const request = await createReview(db, {
      userId: gate.auth.userId,
      recipientId: body.recipientId,
      comment: body.comment,
      snaps,
    });
    return json({ request, demo: true }, 201);
  } catch (e) {
    if (e instanceof BodyError) return json({ error: 'Некорректный запрос', code: 'invalid' }, 400);
    if (e instanceof TargetError) return json({ error: e.message, code: 'target' }, e.status);
    return failure('reviews/create', e);
  }
}
