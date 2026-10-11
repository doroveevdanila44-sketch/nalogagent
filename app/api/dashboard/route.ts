import { NextResponse, type NextRequest } from 'next/server';
import { momentFromEpoch } from '@/lib/calc/time';
import { MissingRuleError } from '@/lib/calc/rules';
import { toPayload } from '@/lib/calc/serialize';
import { dashboardInput, dataKind } from '@/lib/calc/service';
import { failure, json, requireApiAuth } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { loadCalcData } from '@/lib/db/queries';
import { getEnv } from '@/lib/env';
import { buildDashboardProvenance, type DashboardResponse } from '@/lib/provenance/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Вход калькулятора: юрлица, веса, правила на сегодня, факты, выбранные ставки. Расчёт делает клиент.
 * Данные собирает расчётный сервис (lib/calc/service.ts) из тех же таблиц, что чат, документы и
 * выгрузки. В ответе source (откуда цифры) и kind (факт, прогноз или смесь за год), а в provenance
 * строки происхождения под баннерами и карточками юрлиц, собранные из результатов calcTax.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: false });
    if (!gate.ok) return gate.res;
    const { appTz } = getEnv();
    const nowMs = Date.now();
    const today = momentFromEpoch(nowMs, appTz);
    const data = await loadCalcData(getDb(), today);
    const input = dashboardInput(data);
    const body: DashboardResponse = {
      ...toPayload(input, {
        serverNow: nowMs,
        tz: appTz,
        source: data.source,
        kind: dataKind(data, { kind: 'year', year: today.year }),
      }),
      provenance: buildDashboardProvenance(data, appTz, nowMs),
    };
    return json(body);
  } catch (e) {
    if (e instanceof MissingRuleError) {
      return json(
        { error: 'Нет правил НДС на текущий год. Добавьте записи в справочник правил.', code: 'rules_missing' },
        503,
      );
    }
    return failure('dashboard', e);
  }
}
