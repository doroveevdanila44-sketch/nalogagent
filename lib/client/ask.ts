/**
 * Просьба задать вопрос агенту от другой части приложения. Обучение показывает ответ агента на
 * примере: оно просит чат отправить вопрос тем же путём, что и кнопка «Отправить». Слушает чат
 * (components/chat/ChatView.tsx), пока открыта вкладка «Агент».
 */
export const ASK_EVENT = 'pva:ask';

export function askAgent(text: string): void {
  window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { text } }));
}
