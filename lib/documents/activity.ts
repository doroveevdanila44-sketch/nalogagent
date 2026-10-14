/**
 * Вид деятельности юрлица и шаблон договора. Шаблон «аренда без экипажа» обычно подписывает
 * юрлицо без экипажа, «аренда с экипажем и трансфер» юрлицо с такой деятельностью. Вид берётся из
 * справочника юрлиц (legal_entities.activity), а пока он не заполнен, выводится из описания.
 * Это подсказка, а не запрет: несоответствие даёт мягкое предупреждение, создать документ можно.
 */

export type Activity = 'rent_no_crew' | 'rent_with_crew' | 'other';

/** Шаблоны, у которых есть «обычное» юрлицо по виду деятельности. Остальные шаблоны годятся всем. */
export const TEMPLATE_ACTIVITY: Readonly<Record<string, Exclude<Activity, 'other'>>> = {
  contract_rent_no_crew: 'rent_no_crew',
  contract_rent_with_crew: 'rent_with_crew',
};

const KNOWN: readonly Activity[] = ['rent_no_crew', 'rent_with_crew', 'other'];

/** Вид деятельности: из справочника, иначе по описанию («Аренда с экипажем и трансферы»). */
export function activityOf(e: { activity?: string | null; description?: string | null }): Activity {
  if (e.activity && (KNOWN as readonly string[]).includes(e.activity)) return e.activity as Activity;
  const d = (e.description ?? '').toLowerCase();
  if (/без экипаж/.test(d)) return 'rent_no_crew';
  if (/с экипаж|трансфер/.test(d)) return 'rent_with_crew';
  return 'other';
}

/** Юрлица, для которых шаблон «обычный»; пусто, если у шаблона нет привязки к виду деятельности. */
export function usualEntities<T extends { activity: Activity }>(templateKey: string, entities: T[]): T[] {
  const want = TEMPLATE_ACTIVITY[templateKey];
  return want ? entities.filter((e) => e.activity === want) : [];
}

/** Юрлицо по умолчанию для шаблона: первое подходящее по виду деятельности, иначе первое в списке. */
export function defaultEntityId<T extends { id: string; activity: Activity }>(
  templateKey: string,
  entities: T[],
): string {
  return usualEntities(templateKey, entities)[0]?.id ?? entities[0]?.id ?? '';
}

/**
 * Мягкое предупреждение при выборе несоответствующего юрлица; null, если оно подходит или у шаблона
 * нет привязки. names: короткие названия подходящих юрлиц.
 */
export function templateWarning(
  templateKey: string,
  entities: { id: string; name: string; activity: Activity }[],
  chosenId: string,
  short: (name: string) => string,
): string | null {
  const usual = usualEntities(templateKey, entities);
  if (usual.length === 0) return null;
  if (usual.some((e) => e.id === chosenId)) return null;
  const names = usual.map((e) => `«${short(e.name)}»`).join(', ');
  return `Обычно этот шаблон используется для ${names}. Продолжить можно`;
}
