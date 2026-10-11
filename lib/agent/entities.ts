import { cyr } from './regex';
import { normalize } from './text';
import type { EntityRef } from './types';

/**
 * Юрлица в тексте вопроса: по названию в любом падеже («по Альфе», «у Беты», «с Гаммой»),
 * по короткому имени, «все» и «группа». Чужие юрлица («ООО Ромашка», «по Омеге») отдельно:
 * их нет в группе, агент объясняет это, а не молчит.
 */

/** Окончания падежей после основы названия: Альфа, Альфы, Альфе, Альфу, Альфой */
const CASE_ENDINGS = '(?:а|я|е|у|ю|ы|и|ой|ей|ою|ею|ом|ем|ам|ям|ах|ях|ами|ями)?';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Шаблон одного имени (после normalize) с учётом склонения; null, если основа слишком короткая. */
export function aliasRegex(alias: string): RegExp | null {
  const stem = alias.replace(/[аяеиоуыэюь]$/, '');
  if (stem.length < 3) return null;
  return cyr(`(^|[^а-яa-z0-9])${escapeRe(stem)}${CASE_ENDINGS}\\b`);
}

interface Hit {
  entity: EntityRef;
  at: number;
}

/** Все юрлица группы, названные в тексте, в порядке упоминания. */
export function mentionedEntities(text: string, entities: EntityRef[]): EntityRef[] {
  const t = normalize(text);
  const hits: Hit[] = [];
  for (const e of entities) {
    let best = -1;
    for (const alias of e.aliases) {
      const re = aliasRegex(alias);
      if (!re) continue;
      const m = re.exec(t);
      if (m && (best === -1 || m.index < best)) best = m.index;
    }
    if (best !== -1) hits.push({ entity: e, at: best });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.entity);
}

const GROUP = cyr(
  '(^|[^а-яa-z0-9])(все|всех|всем|всеми|весь|всю|всей)($|[^а-яa-z0-9])|групп\\w*|в целом|целиком|суммарн\\w*|совокупн\\w*',
);

/** «все юрлица», «по всей группе», «группа», «в целом». */
export function mentionsGroup(text: string): boolean {
  return GROUP.test(normalize(text));
}

/**
 * Названия, которые похожи на юрлицо, но не из группы: «ООО Ромашка», «ИП Иванов», греческие
 * буквы вне группы («по Омеге»). Возвращает названия так, как написал пользователь.
 */
const FORM_NAME = /(?:^|[^а-яёa-z0-9])(ооо|ип|ао|зао|пао|оао)\s+[«"“']?([а-яёa-z0-9][а-яёa-z0-9-]{1,40})/gi;

const NAME_STOP = new Set([
  'и', 'или', 'по', 'за', 'на', 'в', 'с', 'у', 'для', 'это', 'как', 'что', 'то', 'все', 'всех', 'всем',
  'группы', 'группа', 'группе', 'группу', 'ндс', 'усн', 'налог', 'налога', 'налоги', 'налогу', 'упрощенке',
  'упрощенка', 'упрощёнке', 'упрощёнка', 'осно', 'сколько', 'какой', 'какая', 'какие', 'платит', 'платят',
]);

/** Греческие названия вне группы. Короткие и совпадающие с обычными словами («эта», «пи») не берём. */
const OUTSIDE_NAMES = [
  'дзета', 'зета', 'тета', 'йота', 'иота', 'каппа', 'лямбда', 'ламбда', 'омикрон', 'сигма', 'тау',
  'ипсилон', 'омега',
];

export function unknownEntityNames(text: string, entities: EntityRef[]): string[] {
  const found: string[] = [];
  const known = (candidate: string) => mentionedEntities(candidate, entities).length > 0;

  for (const m of text.matchAll(FORM_NAME)) {
    const name = m[2]!;
    const lower = normalize(name);
    if (NAME_STOP.has(lower)) continue;
    // «ООО Альфа» это своё юрлицо
    if (known(`${m[1]} ${name}`) || known(name)) continue;
    found.push(`${m[1]!.toUpperCase()} ${name}`);
  }

  const t = normalize(text);
  for (const g of OUTSIDE_NAMES) {
    const stem = g.replace(/[аяеиоуыэюь]$/, '');
    const m = cyr(`(^|[^а-яa-z0-9])(${escapeRe(stem)}${CASE_ENDINGS})\\b`).exec(t);
    if (m) found.push(m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1));
  }
  return [...new Set(found)];
}

/** «ООО «Альфа»» → «Альфа». Короткое имя для кнопок и подсказок. */
export function shortName(e: EntityRef): string {
  const first = e.aliases[0] ?? e.name;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** «Альфа» → «Альфе», «Эпсилон» → «Эпсилону»: для «по Альфе». */
export function dativeName(short: string): string {
  if (/[ая]$/.test(short)) return short.replace(/[ая]$/, 'е');
  if (/ь$/.test(short)) return short.replace(/ь$/, 'ю');
  return `${short}у`;
}
