import type { LlmProvider } from '@/lib/agent/provider';
import type { SuggestRequest } from './types';

/**
 * Предложения формулировок для текстовых пунктов. Идут через общий интерфейс провайдера
 * (LlmProvider.suggest); в заглушке готовые варианты. Предложение это только текст: суммы и даты
 * в документ попадают из расчёта, поэтому любой вариант с цифрой или названием месяца отбрасывается.
 */

const READY: Record<string, string[]> = {
  special_terms: [
    'Автомобиль передаётся с полным баком топлива и возвращается с полным баком.',
    'Выезд за пределы региона допускается только с письменного согласия Арендодателя.',
    'Курение в салоне и перевозка животных без переноски не допускаются.',
  ],
  route: [
    'Подача автомобиля по адресу Заказчика, доставка пассажиров в аэропорт и обратно, ожидание водителя входит в стоимость заказа.',
    'Маршрут согласуется Заказчиком с диспетчером Исполнителя до начала поездки, остановки по пути оговариваются отдельно.',
  ],
  purpose: [
    'Справка подготовлена для сверки расчёта налога с бухгалтером и не является налоговой отчётностью.',
    'Справка подготовлена для внутреннего контроля группы компаний и содержит ориентировочные суммы.',
  ],
};

const FALLBACK = [
  'Стороны согласуют этот пункт дополнительно, изменения оформляются в письменной форме.',
  'Условие действует в течение срока договора и может быть изменено по соглашению сторон.',
];

export const MONTH_WORDS =
  /январ|феврал|март|апрел|\bмая\b|\bмай\b|июн|июл|август|сентябр|октябр|ноябр|декабр/i;

/** Готовые варианты заглушки по ключу поля. */
export function readyVariants(fieldKey: string): string[] {
  return READY[fieldKey] ?? FALLBACK;
}

/** Оставляет только предложения без цифр, дат и сумм; пустой результат заменяется готовыми. */
export function sanitizeSuggestions(list: string[], fieldKey: string): string[] {
  const ok = list
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 0 && t.length <= 400 && !/\d/.test(t) && !MONTH_WORDS.test(t) && !/[₽$€]|руб/i.test(t));
  return ok.length > 0 ? ok.slice(0, 4) : readyVariants(fieldKey);
}

export async function suggestText(provider: LlmProvider, req: SuggestRequest): Promise<string[]> {
  let raw: string[] = [];
  try {
    raw = provider.suggest ? await provider.suggest(req) : readyVariants(req.fieldKey);
  } catch {
    raw = [];
  }
  return sanitizeSuggestions(raw, req.fieldKey);
}
