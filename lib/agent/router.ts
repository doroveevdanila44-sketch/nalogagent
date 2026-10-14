import type { Moment } from '@/lib/calc';
import { extractFields } from './interpret';
import { cyr } from './regex';
import { normalize } from './text';
import type { AgentClass, EntityRef, Pending, Slot } from './types';

/**
 * Маршрутизатор без модели. Порядок (AGENT.md):
 *  1. точные совпадения: приветствия, благодарности, прощания, /start, /help;
 *  2. запросы о схемах обхода: класс F. Проверяется раньше словаря темы, чтобы фраза
 *     «как раздробить, чтобы не платить НДС» не ушла в расчёт (в AGENT.md F стоит после словаря);
 *  3. словарь темы: класс A;
 *  4. явно не по теме: класс D;
 *  5. иначе класс E, уточняющий вопрос.
 *
 * Шаблоны пишутся для текста после normalize() и компилируются через cyr(): в JavaScript
 * \b и \w не знают кириллицу.
 */
export type Route =
  | { cls: 'B'; kind: 'greeting' | 'thanks' | 'farewell' }
  | { cls: 'C' }
  | { cls: 'D' }
  | { cls: 'E' }
  | { cls: 'F' }
  | { cls: 'A' };

const GREETING = cyr(
  '^(привет\\w*|здравству\\w*|здрасьте|добр\\w+ (день|вечер|утро|ночи)|доброе утро|добрый|хай|здорово|здарова|салют|приветствую|hello|hi|hey)\\b',
);
const THANKS = cyr('^((большое |огромное |еще раз )?спасибо|благодарю|благодарствую|спс|мерси|thanks|thank you)\\b');
const FAREWELL = cyr(
  '^(пока|до свидания|досвидания|до встречи|всего доброго|до связи|прощайте|прощай|bye|увидимся|хорошего дня|доброй ночи|всего хорошего)\\b',
);
const SERVICE = cyr(
  '(^/(start|help)\\b|^(help|помощь|справка)\\b|что (ты )?(умеешь|можешь)|что ты такое|чем (ты )?(можешь )?помочь|твои возможности|как с тобой работать|что (ты )?делаешь)',
);

const BOUNDARY = cyr(
  '(раздроб|дроби(ть|м)\\b|обойт[иь]|обход\\w*|уклон\\w*|уклоня\\w+|спрят\\w+|скрыт[ьи]|скрыва\\w+|незаметн\\w+|не заметил\\w*|чтоб\\w* не (заметил|увидел|нашл|доказал|поняли)|занизит\\w+|занижен\\w+ выруч|серую схему|серая схема|левы[ех] (договор|схем)|фиктивн\\w+|вывест\\w+ (деньги|выручк))',
);

const STRONG_TOPIC = cyr(
  '(ндс|ставк\\w*|порог\\w*|вычет\\w*|деклараци\\w*|квартал\\w*|упрощ\\w*|\\bусн\\b|дроблен\\w*|юрлиц\\w*|юридическ\\w+ лиц\\w*|дефлятор\\w*|лимит\\w*|(?<![0-9])(5|7|22) ?(%|процент\\w*)|едины\\w+ бизнес\\w*)',
);
const WEAK_TOPIC = cyr(
  '(налог\\w*|расчет\\w*|посчита\\w*|подсчита\\w*|рассчита\\w*|начисл\\w*|ндфл|взнос\\w*|енвд|патент\\w*|выруч\\w*|прибыл\\w*|плат[ее]ж\\w*|платит\\w*|заплат\\w*|прогноз\\w*|предупрежд\\w*|риск\\w*|освобожд\\w*|пересеч\\w*|машин\\w*|автомоб\\w*|лизинг\\w*|закуп\\w*|покуп\\w*|купим|купить|сценари\\w*|экономи\\w*|групп\\w*|20 млн|срок\\w*|оплат\\w*|к уплате|бюджет\\w*|счет[- ]фактур\\w*|счета[- ]фактур\\w*|сравни\\w*|объедин\\w*)',
);

/** Просьба об оценке схемы с точки зрения закона: отказ из набора, а не расчёт. */
const LEGAL = cyr(
  'законн\\w*|легальн\\w*|незаконн\\w*|правомерн\\w*|можно ли так|накажут|оштрафуют|уголовн\\w*|признает ли (налоговая|фнс)|юридическ\\w+ (оценк|заключени|консультац)\\w*|оцени\\w* схем\\w*|судебн\\w*',
);

const OFF_TOPIC = cyr(
  '(погод\\w*|стих\\w*|анекдот\\w*|рецепт\\w*|футбол\\w*|хокке\\w*|чемпион\\w*|матч\\w*|спорт\\w*|кино\\b|фильм\\w*|сериал\\w*|музык\\w*|песн\\w*|спой\\w*|гороскоп\\w*|шутк\\w*|сказк\\w*|тост\\w*|пицц\\w*|борщ\\w*|как дела|кто ты|как тебя зовут|сколько тебе лет|курс (доллар|евро|валют|биткоин)\\w*|биткоин\\w*|новост\\w*|президент\\w*|политик\\w*|игр[аыу]\\b|поиграем|путешеств\\w*|отпуск\\w*|переведи\\w*|напиши (код|программ|реферат|сочинение|письмо)|python|javascript|реферат|сочинение|смысл жизни|любов\\w+)',
);

function wordCount(t: string): number {
  return t.split(' ').filter(Boolean).length;
}

/** Окончания падежей, допустимые после основы названия: Альфа, Альфы, Альфе, Альфу, Альфой */
const CASE_ENDINGS = '(?:а|я|е|у|ю|ы|и|ой|ей|ою|ею|ом|ем|ам|ям|ах|ях|ами|ями)?';

/** Находит юрлицо в тексте с учётом склонения: «по Альфе», «у Беты», «для Дельты». */
export function mentionsEntity(text: string, entities: EntityRef[]): EntityRef | null {
  const t = normalize(text);
  for (const e of entities) {
    for (const alias of e.aliases) {
      const stem = alias.replace(/[аяеиоуыэюь]$/, '');
      if (stem.length < 3) continue;
      const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = cyr(`(^|[^а-яa-z0-9])${escaped}${CASE_ENDINGS}\\b`);
      if (re.test(t)) return e;
    }
  }
  return null;
}

/** Что известно о ходе разговора: чего ждёт агент и был ли прошлый ответ с понятым вопросом. */
export interface RouteContext {
  today: Moment;
  awaiting: Slot[];
  hasPrevious: boolean;
}

export function classify(
  question: string,
  opts: { entities?: EntityRef[]; pending?: Pending | null; context?: RouteContext } = {},
): Route {
  const t = normalize(question);
  const entities = opts.entities ?? [];

  // 1. точные совпадения (короткие фразы)
  if (wordCount(t) <= 6) {
    if (SERVICE.test(t)) return { cls: 'C' };
    if (THANKS.test(t)) return { cls: 'B', kind: 'thanks' };
    if (FAREWELL.test(t)) return { cls: 'B', kind: 'farewell' };
    if (GREETING.test(t) && !STRONG_TOPIC.test(t) && !WEAK_TOPIC.test(t)) return { cls: 'B', kind: 'greeting' };
  }
  if (SERVICE.test(t) && wordCount(t) <= 8) return { cls: 'C' };

  // 1а. оценка схемы с точки зрения закона: ответ строит интерпретация (отказ из набора)
  if (LEGAL.test(t)) return { cls: 'A' };

  // 2. схемы обхода
  if (BOUNDARY.test(t)) return { cls: 'F' };

  // ответ на уточняющий вопрос: число или юрлицо при незавершённом запросе
  if (opts.pending && (/\d/.test(t) || mentionsEntity(t, entities))) return { cls: 'A' };

  // короткий ответ на уточнение или поправка к прежнему вопросу: «февраль», «УСН», «по Бете»
  if (opts.context && (opts.context.awaiting.length > 0 || opts.context.hasPrevious)) {
    const f = extractFields(question, { entities, today: opts.context.today });
    const slot =
      f.all ||
      f.entities.length > 0 ||
      f.taxes.length > 0 ||
      f.periods.length > 0 ||
      f.rate !== null ||
      f.growth !== null ||
      f.whatIf !== null;
    if ((f.fragment || f.whatIf !== null) && slot) return { cls: 'A' };
  }

  // 3. словарь темы
  if (STRONG_TOPIC.test(t)) return { cls: 'A' };
  if (mentionsEntity(t, entities)) return { cls: 'A' };

  // 4. явно не по теме, затем слабые слова темы
  if (OFF_TOPIC.test(t)) return { cls: 'D' };
  if (WEAK_TOPIC.test(t)) return { cls: 'A' };

  // 5. непонятное
  return { cls: 'E' };
}

export type { AgentClass };
