import { getEnv } from '@/lib/env';
import type { LlmProvider } from './provider';
import { StubProvider } from './stub';

/**
 * Выбор провайдера по LLM_PROVIDER. В демо работает только stub.
 * GigaChat и YandexGPT подключаются на этапе 7 (docs/PROMPTS.md): до тех пор любое значение,
 * кроме stub, честно откатывается на заглушку и пишет предупреждение, а не падает.
 */
export function getProvider(): LlmProvider {
  const name = getEnv().llmProvider;
  if (name !== 'stub') {
    console.warn(`[agent] провайдер ${name} ещё не подключён, используется stub`);
  }
  return new StubProvider();
}
