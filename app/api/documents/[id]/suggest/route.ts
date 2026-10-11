import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getProvider } from '@/lib/agent/provider-factory';
import { readJson } from '@/lib/auth/request';
import { json } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { docRoute, type IdContext } from '@/lib/documents/http';
import { DocError, getDocument } from '@/lib/documents/service';
import { suggestText } from '@/lib/documents/suggest';
import { getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ fieldKey: z.string().min(1).max(64) });

/**
 * Предложение формулировки для текстового пункта. Идёт через общий интерфейс провайдера (в заглушке
 * готовые варианты). Предложение это только слова: суммы и даты в документ попадают из расчёта,
 * поэтому варианты с цифрами отбрасываются.
 */
export async function POST(req: NextRequest, ctx: IdContext): Promise<NextResponse> {
  return docRoute(req, 'documents/suggest', { mutating: true }, async ({ userId }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, Body);
    const doc = await getDocument(getDb(), { userId, id, tz: getEnv().appTz });
    const field = doc.fields.find((f) => f.key === body.fieldKey);
    if (!field || !field.suggest || field.source !== 'user') {
      throw new DocError(422, 'suggest', 'Для этого поля предложений нет');
    }
    const suggestions = await suggestText(getProvider(), {
      templateKey: doc.templateKey,
      fieldKey: field.key,
      label: field.label,
      entityName: doc.entityName,
      periodLabel: doc.periodLabel,
    });
    return json({ suggestions });
  });
}
