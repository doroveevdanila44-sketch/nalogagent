import { asc } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import { json } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { legalEntities } from '@/lib/db/schema';
import { docRoute } from '@/lib/documents/http';
import { listTemplates } from '@/lib/documents/service';
import { SAMPLE_NOTE } from '@/lib/documents/types';
import { momentFromEpoch } from '@/lib/calc/time';
import { getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Каталог шаблонов и юрлица для выбора. Тела шаблонов клиенту не нужны. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return docRoute(req, 'documents/templates', { mutating: false }, async () => {
    const db = getDb();
    const [templates, entities] = await Promise.all([
      listTemplates(db),
      db
        .select({ id: legalEntities.id, name: legalEntities.name, form: legalEntities.form })
        .from(legalEntities)
        .orderBy(asc(legalEntities.sort), asc(legalEntities.id)),
    ]);
    const now = momentFromEpoch(Date.now(), getEnv().appTz);
    return json({
      sample: SAMPLE_NOTE,
      year: now.year,
      month: now.month + 1,
      entities,
      templates: templates.map((t) => ({
        key: t.key,
        category: t.category,
        title: t.title,
        description: t.description,
        scope: t.scope,
        needsPeriod: t.needsPeriod,
        output: t.output,
        taxes: t.taxes,
        fields: t.fields.length,
        required: t.fields.filter((f) => f.required).length,
      })),
    });
  });
}
