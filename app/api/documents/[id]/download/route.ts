import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { XLSX_MIME, contentDisposition } from '@/lib/documents/file-name';
import { docRoute, type IdContext } from '@/lib/documents/http';
import { documentSnapshots, downloadDocument } from '@/lib/documents/service';
import { getEnv } from '@/lib/env';
import { excelFor } from '@/lib/provenance/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Скачивание: ?calc=1 отдаёт Excel расчёта, на котором стоят суммы документа (панель «Показать
 * расчёт» и «Проверить самому»). Без calc это тот же файл, что отдаёт /api/documents/[id]/file.
 */
export async function GET(req: NextRequest, ctx: IdContext): Promise<NextResponse> {
  return docRoute(req, 'documents/download', { mutating: false }, async ({ userId }) => {
    const { id } = await ctx.params;
    const v = Number(req.nextUrl.searchParams.get('version'));
    const version = Number.isInteger(v) && v > 0 ? v : null;
    const db = getDb();
    let out: { name: string; mime: string; file: Buffer };
    if (req.nextUrl.searchParams.get('calc') === '1') {
      const snaps = await documentSnapshots(db, { userId, id, version });
      const x = await excelFor(snaps);
      out = { name: x.name, file: x.file, mime: XLSX_MIME };
    } else {
      out = await downloadDocument(db, { userId, id, version, tz: getEnv().appTz });
    }
    return new NextResponse(new Uint8Array(out.file), {
      status: 200,
      headers: {
        'Content-Type': out.mime,
        'Content-Disposition': contentDisposition(out.name, 'attachment'),
        'Content-Length': String(out.file.length),
        'Cache-Control': 'no-store',
      },
    });
  });
}
