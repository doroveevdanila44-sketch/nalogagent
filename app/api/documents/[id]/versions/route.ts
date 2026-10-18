import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { readJson } from '@/lib/auth/request';
import { json } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { docRoute, type IdContext } from '@/lib/documents/http';
import { MAX_VERSION } from '@/lib/documents/ids';
import { saveVersion } from '@/lib/documents/service';
import { getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  /** Версия, на которой сделаны правки: должна быть нынешней */
  baseVersion: z.number().int().min(1).max(MAX_VERSION),
  values: z.record(z.string().max(64), z.string().max(2100)).default({}),
  /** Пересчитать суммы по актуальным данным и реквизитам */
  refreshCalc: z.boolean().optional(),
});

/**
 * Правка документа. Существующая версия не меняется, создаётся следующая, документ возвращается
 * в «Черновик». Менять версию на месте (PUT, PATCH, DELETE) нельзя: таких маршрутов нет.
 */
export async function POST(req: NextRequest, ctx: IdContext): Promise<NextResponse> {
  return docRoute(req, 'documents/version', { mutating: true }, async ({ userId }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, Body);
    const res = await saveVersion(getDb(), {
      userId,
      id,
      baseVersion: body.baseVersion,
      edits: body.values,
      refreshCalc: body.refreshCalc,
      nowMs: Date.now(),
      tz: getEnv().appTz,
    });
    return json(res, 201);
  });
}
