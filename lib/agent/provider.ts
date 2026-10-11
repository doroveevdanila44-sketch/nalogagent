import type { InterpretContext, RawFields } from './interpret';
import type { SuggestRequest } from '@/lib/documents/types';
import type { CalcResult, ParseContext, ParsedIntent } from './types';

/**
 * Единый интерфейс языковой модели. Весь доступ к модели идёт через него (AGENT.md).
 * Реализации выбираются переменной LLM_PROVIDER. Модель не считает: она извлекает поля вопроса
 * (extract) и превращает готовое число в слова (explain). Числа считает calcTax, а какой ответ
 * строить, что переспросить и чего не поддерживать, решает код по полям (interpret.ts).
 */
export interface LlmProvider {
  readonly name: string;
  /** Вопрос в параметры прежних разделов (сценарий покупки машин и т.п.) */
  parse(question: string, ctx: ParseContext): Promise<ParsedIntent>;
  /** Готовый результат расчёта в слова */
  explain(result: CalcResult, question: string): Promise<string>;
  /**
   * Поля вопроса: юрлица, налог, период, сценарий. Необязательный метод: без него работают
   * правила заглушки. Всё, что вернула модель, проходит проверку sanitizeFields.
   */
  extract?(question: string, ctx: InterpretContext): Promise<Partial<RawFields>>;
  /**
   * Предложения формулировки для текстового пункта документа. Модель пишет только слова: суммы и даты
   * подставляет код из расчёта, поэтому варианты с цифрами отбрасываются (lib/documents/suggest.ts).
   */
  suggest?(req: SuggestRequest): Promise<string[]>;
}
