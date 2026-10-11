import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { docRoute, type IdContext } from '@/lib/documents/http';
import { documentSnapshots, downloadDocument } from '@/lib/documents/service';
import { getEnv } from '@/lib/env';
import { excelFor } from '@/lib/provenance/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function disposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="document"; filename*=UTF-8''${encoded}`;
}

/**
 * Файл документа: .docx для договоров и отчётов, .xlsx для проектов деклараций. ?version=N берёт
 * версию из истории, ?calc=1 отдаёт Excel расчёта, на котором стоят суммы документа.
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
      out = { name: x.name, file: x.file, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    } else {
      out = await downloadDocument(db, { userId, id, version, tz: getEnv().appTz });
    }
    return new NextResponse(new Uint8Array(out.file), {
      status: 200,
      headers: {
        'Content-Type': out.mime,
        'Content-Disposition': disposition(out.name),
        'Content-Length': String(out.file.length),
        'Cache-Control': 'no-store',
      },
    });
  });
}
