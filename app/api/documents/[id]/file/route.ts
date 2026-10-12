import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { contentDisposition } from '@/lib/documents/file-name';
import { docRoute, type IdContext } from '@/lib/documents/http';
import { downloadDocument } from '@/lib/documents/service';
import { getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Файл документа: .docx для договоров, допсоглашений и отчётов, .xlsx для проектов деклараций.
 * Без параметров это актуальная версия. Документ открывается в приложении страницей /documents/[id];
 * сюда ведёт только «Скачать .docx» («Скачать .xlsx») в меню «ещё» этой страницы.
 *   ?version=N  версия из истории (в имени файла « (версия N)»)
 *   ?inline=1   показать, а не сохранять (встроенный просмотр)
 */
export async function GET(req: NextRequest, ctx: IdContext): Promise<NextResponse> {
  return docRoute(req, 'documents/file', { mutating: false }, async ({ userId }) => {
    const { id } = await ctx.params;
    const v = Number(req.nextUrl.searchParams.get('version'));
    const version = Number.isInteger(v) && v > 0 ? v : null;
    const inline = req.nextUrl.searchParams.get('inline') === '1';
    const out = await downloadDocument(getDb(), { userId, id, version, tz: getEnv().appTz });
    return new NextResponse(new Uint8Array(out.file), {
      status: 200,
      headers: {
        'Content-Type': out.mime,
        'Content-Disposition': contentDisposition(out.name, inline ? 'inline' : 'attachment'),
        'Content-Length': String(out.file.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
