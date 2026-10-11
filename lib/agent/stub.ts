import { extractFields, type InterpretContext, type RawFields } from './interpret';
import { cyr } from './regex';
import { mentionsEntity } from './router';
import type { LlmProvider } from './provider';
import { normalize } from './text';
import type { CalcResult, Intent, ParseContext, ParsedIntent } from './types';

/**
 * Провайдер «заглушка»: правила и регулярные выражения, как функция reply в reference/demo.html.
 * Работает без внешних сервисов и без токенов. Это же базовая реализация для тестов интерфейса.
 */
const WORD_NUMBERS: Record<string, number> = {
  одну: 1, одна: 1, один: 1, две: 2, два: 2, три: 3, четыре: 4, пять: 5, шесть: 6,
  семь: 7, восемь: 8, девять: 9, десять: 10,
};

function parseCars(t: string): number | null {
  const digits = t.match(cyr('(\\d+)\\s*(?:машин\\w*|авто\\w*|шт\\b|штук\\w*|автомобил\\w*)'));
  if (digits) return parseInt(digits[1]!, 10);
  const word = t.match(
    cyr('\\b(одну|одна|один|две|два|три|четыре|пять|шесть|семь|восемь|девять|десять)\\s+(?:машин\\w*|авто\\w*|автомобил\\w*)'),
  );
  if (word) return WORD_NUMBERS[word[1]!] ?? null;
  return null;
}

function parsePriceMln(t: string): number | null {
  const m = t.match(cyr('(\\d+(?:[.,]\\d+)?)\\s*(?:млн|м\\b|миллион\\w*)'));
  return m ? parseFloat(m[1]!.replace(',', '.')) : null;
}

const PROFIT = cyr('прибыл|\\bусн\\b|упрощ|налог\\w* по усн|налог\\w* на доход');

const SCENARIO = cyr(
  'куп(им|ит|ить|ка|или|лю|ишь|ите|ят|ленн\\w*)|приобре\\w+|покуп|новых? (машин|авто)|добав\\w* (машин|авто)|лизинг|(машин|авто|автомобил)\\w* по \\d|\\d+ (машин|авто|автомобил)',
);

function detectIntent(t: string): Intent | null {
  if (/раздроб|обойти|спрят|незамет|скрыть/.test(t)) return 'boundary';
  if (SCENARIO.test(t)) return 'scenario';
  if (PROFIT.test(t)) return 'profit';
  if (/порог|предупрежд|20 млн|освобожд|риск|пересеч/.test(t)) return 'warnings';
  if (/дроблен|объедин|единый бизнес|признак/.test(t)) return 'fragmentation';
  if (/вычет|входящ|входной/.test(t)) return 'deduct';
  if (/квартал|прогноз|сколько.*(заплат|налог|платить)|к уплате|срок|платеж|платёж/.test(t)) return 'forecast';
  if (/ставк|5%|7%|22|выгодн|выбрат|ндс|налог/.test(t)) return 'rates';
  return null;
}

export class StubProvider implements LlmProvider {
  readonly name = 'stub';

  async parse(question: string, ctx: ParseContext): Promise<ParsedIntent> {
    const t = normalize(question);
    const own = detectIntent(t);
    const entity = mentionsEntity(t, ctx.entities);
    const cars = parseCars(t);
    const priceMln = parsePriceMln(t);
    const p = ctx.pending;

    // Есть собственное намерение: оно главнее ожидающего запроса
    if (own) {
      const carry = p && p.intent === own;
      return {
        intent: own,
        entityId: entity?.id ?? (carry ? p.entityId : null) ?? null,
        cars: cars ?? (carry ? p.cars : null) ?? null,
        priceMln: priceMln ?? (carry ? p.priceMln : null) ?? null,
      };
    }

    // Ответ на уточняющий вопрос
    if (p) {
      let price = priceMln;
      // «7 млн» без слова «машин» уже разобрано как цена; одиночное число считаем недостающим
      const bare = t.match(/^\D*(\d+(?:[.,]\d+)?)\D*$/);
      let n = cars;
      if (bare && p.missing.includes('cars') && !p.missing.includes('price') && n === null) {
        n = Math.round(parseFloat(bare[1]!.replace(',', '.')));
      } else if (bare && p.missing.includes('price') && !p.missing.includes('cars') && price === null) {
        price = parseFloat(bare[1]!.replace(',', '.'));
      }
      return {
        intent: p.intent,
        entityId: entity?.id ?? p.entityId ?? null,
        cars: n ?? p.cars ?? null,
        priceMln: price ?? p.priceMln ?? null,
      };
    }

    // «а по Бете?»: то же намерение, что в прошлом ответе (расчёт суммы продолжает interpret.ts)
    if (entity && ctx.lastIntent && ctx.lastIntent !== 'amount') {
      return { intent: ctx.lastIntent, entityId: entity.id };
    }
    return { intent: 'unknown', entityId: entity?.id ?? null };
  }

  /** Поля вопроса правилами. GigaChat позже вернёт те же поля из ответа модели. */
  async extract(question: string, ctx: InterpretContext): Promise<Partial<RawFields>> {
    return extractFields(question, ctx);
  }

  async explain(result: CalcResult): Promise<string> {
    return result.paragraphs.join('\n\n');
  }
}
