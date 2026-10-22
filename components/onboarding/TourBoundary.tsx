'use client';

import { Component, type ReactNode } from 'react';

/**
 * Страховка вокруг обучения. Ошибка внутри тура (шаг, которого нет, пропавший элемент, сбой в
 * подготовке примера) не должна показывать «Что-то пошло не так» на всю страницу: обучение молча
 * закрывается через onFail (оно же отмечает показ), приложение остаётся на экране. Причина пишется
 * в консоль: имя и сообщение, без стека и без данных человека.
 */
export class TourBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.error('[tour] обучение закрыто из-за ошибки', { name: error.name, message: error.message });
    this.props.onFail();
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
