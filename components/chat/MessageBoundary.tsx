'use client';

import { Component, type ReactNode } from 'react';
import type { ChatTurn } from '@/lib/agent/types';

/**
 * Страховка вокруг одного сообщения чата. История читается из базы, и сообщение, сохранённое прежней
 * версией (другой вид карточки «Понял так», кнопок, происхождения цифр, таблицы), может не сойтись с
 * нынешней разметкой. Без этой границы один такой ответ ронял всю вкладку «Агент» экраном «Что-то
 * пошло не так». Теперь сообщение, которое не отрисовалось, показывается простым текстом, остальная
 * лента и поле ввода работают. Причина пишется в консоль: номер сообщения, имя и сообщение ошибки.
 */
export class MessageBoundary extends Component<
  { turn: Pick<ChatTurn, 'id' | 'role' | 'text'>; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.error(`[chat] сообщение ${this.props.turn.id} показано текстом из-за ошибки`, {
      name: error.name,
      message: error.message,
    });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { turn } = this.props;
    return (
      <div className={turn.role === 'user' ? 'msg me' : 'msg'} data-testid="msg-fallback">
        {typeof turn.text === 'string' ? turn.text : ''}
      </div>
    );
  }
}
