import type { CalcResult, ParseContext, ParsedIntent } from './types';

/**
 * Единый интерфейс языковой модели. Весь доступ к модели идёт через него (AGENT.md).
 * Реализации выбираются переменной LLM_PROVIDER. Модель не считает: parse превращает вопрос
 * в параметры, explain превращает готовое число в слова. Числа в explain проверяет предохранитель.
 */
export interface LlmProvider {
  readonly name: string;
  /** Вопрос в параметры расчёта */
  parse(question: string, ctx: ParseContext): Promise<ParsedIntent>;
  /** Готовый результат расчёта в слова */
  explain(result: CalcResult, question: string): Promise<string>;
}
