/**
 * Идентификатор документа: UUID в каноническом виде. Всё остальное отсекается до базы: Postgres на
 * строку не UUID отвечает ошибкой 22P02, и сервер отдавал бы 500 вместо «Документ не найден».
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (id: unknown): id is string => typeof id === 'string' && UUID.test(id);

/** Номер версии документа помещается в int4: больше базе не передаётся. */
export const MAX_VERSION = 2_147_483_647;
export const isVersionNumber = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_VERSION;
