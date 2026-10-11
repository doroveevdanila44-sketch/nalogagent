import { NextResponse, type NextRequest } from 'next/server';
import { BodyError } from '@/lib/auth/request';
import { failure, json, requireApiAuth } from '@/lib/auth/server';
import { FieldError } from './fill';
import { DocError } from './service';
import { WorkflowError } from './workflow';

type Auth = { userId: string };
export type IdContext = { params: Promise<{ id: string }> };

/**
 * Общая обёртка маршрутов документов: вход и CSRF для изменяющих запросов, перевод ошибок домена
 * (документ не найден, переход не разрешён, поле не прошло проверку) в ответы с кодом и текстом.
 */
export async function docRoute(
  req: NextRequest,
  scope: string,
  opts: { mutating: boolean },
  run: (auth: Auth) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: opts.mutating });
    if (!gate.ok) return gate.res;
    return await run({ userId: gate.auth.userId });
  } catch (e) {
    if (e instanceof BodyError) return json({ error: 'Некорректный запрос', code: 'invalid' }, 400);
    if (e instanceof DocError) return json({ error: e.message, code: e.code, ...e.data }, e.status);
    if (e instanceof FieldError) return json({ error: e.message, code: 'field', field: e.field }, 422);
    if (e instanceof WorkflowError) return json({ error: e.message, code: e.code }, 409);
    return failure(scope, e);
  }
}
