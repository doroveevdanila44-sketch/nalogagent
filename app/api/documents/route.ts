import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { readJson } from '@/lib/auth/request';
import { json } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { docRoute } from '@/lib/documents/http';
import { createDocument, listDocuments } from '@/lib/documents/service';
import { getEnv } from '@/lib/env';
import { PeriodSchema } from '@/lib/provenance/schemas';
import { appNow } from '@/lib/clock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  templateKey: z.string().min(1).max(64),
  entityId: z.string().min(1).max(64).nullable().optional(),
  period: PeriodSchema.nullable().optional(),
  /** Введённое вручную при создании: ключ поля в строку */
  values: z.record(z.string().max(64), z.string().max(2100)).optional(),
});

/** Мои документы. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return docRoute(req, 'documents/list', { mutating: false }, async ({ userId }) => {
    return json({ documents: await listDocuments(getDb(), userId) });
  });
}

/** Создать документ из шаблона: реквизиты юрлица и суммы из расчёта подставляются сразу. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return docRoute(req, 'documents/create', { mutating: true }, async ({ userId }) => {
    const body = await readJson(req, Body);
    const id = await createDocument(getDb(), {
      userId,
      templateKey: body.templateKey,
      entityId: body.entityId ?? null,
      period: body.period ?? null,
      user: body.values,
      nowMs: appNow(),
      tz: getEnv().appTz,
    });
    return json({ id }, 201);
  });
}
