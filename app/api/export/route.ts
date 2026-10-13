import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { failure, json, requireApiAuth } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { contentDisposition } from '@/lib/documents/file-name';
import { getEnv } from '@/lib/env';
import { QueriesTargetSchema } from '@/lib/provenance/schemas';
import { excelFor, resolveTarget, reviewExcel, TargetError } from '@/lib/provenance/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function file(name: string, body: Buffer): NextResponse {
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': XLSX,
      'Content-Disposition': contentDisposition(name, 'attachment'),
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    },
  });
}

const Query = z.union([
  z.object({ q: z.string().min(2).max(4000) }),
  z.object({ message: z.coerce.number().int().positive() }),
  z.object({ review: z.string().uuid() }),
]);

/**
 * Выгрузка в Excel. Один из параметров:
 *  q        JSON запросов расчёта {queries, at}: файл считается сейчас на момент at;
 *  message  номер ответа чата: файл строится из сохранённого снимка ответа;
 *  review   номер запроса на проверку: отдаётся файл, сохранённый при отправке.
 * Суммы в файле это те же числа calcTax, что на экране и в панели «Показать расчёт».
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: false });
    if (!gate.ok) return gate.res;
    const sp = req.nextUrl.searchParams;
    const parsed = Query.safeParse(Object.fromEntries(sp.entries()));
    if (!parsed.success) return json({ error: 'Некорректный запрос', code: 'invalid' }, 400);
    const db = getDb();
    const q = parsed.data;

    if ('review' in q) {
      const stored = await reviewExcel(db, { userId: gate.auth.userId, id: q.review });
      if (!stored) return json({ error: 'Запрос не найден', code: 'not_found' }, 404);
      return file(stored.name, stored.file);
    }

    let target;
    if ('message' in q) {
      target = { message: q.message };
    } else {
      let raw: unknown;
      try {
        raw = JSON.parse(q.q);
      } catch {
        return json({ error: 'Некорректный запрос', code: 'invalid' }, 400);
      }
      const checked = QueriesTargetSchema.safeParse(raw);
      if (!checked.success) return json({ error: 'Некорректный запрос', code: 'invalid' }, 400);
      target = checked.data;
    }

    const snaps = await resolveTarget(db, {
      userId: gate.auth.userId,
      target,
      nowMs: Date.now(),
      tz: getEnv().appTz,
    });
    const out = await excelFor(snaps);
    return file(out.name, out.file);
  } catch (e) {
    if (e instanceof TargetError) return json({ error: e.message, code: 'target' }, e.status);
    return failure('export', e);
  }
}
