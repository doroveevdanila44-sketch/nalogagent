import type { DocStatus } from './types';

/**
 * Процесс согласования документа. Статусы: Черновик, На проверке, Есть замечания, Согласовано,
 * Отозвано. Версия документа неизменяема: правка всегда создаёт новую версию и возвращает документ
 * в «Черновик», в том числе правка согласованного документа (согласованная версия остаётся как была).
 *
 *   draft     правка, отправка на проверку
 *   review    замечание, согласование, отзыв; править нельзя: сначала отозвать
 *   remarks   правка (в Черновик), отзыв
 *   approved  правка (в Черновик), отзыв
 *   withdrawn правка (в Черновик)
 */

export type WorkflowEvent = 'edit' | 'submit' | 'withdraw' | 'remark' | 'approve';

export class WorkflowError extends Error {
  constructor(
    public code: 'edit_locked' | 'bad_transition',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

const TABLE: Record<DocStatus, Partial<Record<WorkflowEvent, DocStatus>>> = {
  draft: { edit: 'draft', submit: 'review' },
  review: { withdraw: 'withdrawn', remark: 'remarks', approve: 'approved' },
  remarks: { edit: 'draft', withdraw: 'withdrawn' },
  approved: { edit: 'draft', withdraw: 'withdrawn' },
  withdrawn: { edit: 'draft' },
};

export function transition(status: DocStatus, event: WorkflowEvent): DocStatus {
  const next = TABLE[status][event];
  if (!next) {
    if (event === 'edit') {
      throw new WorkflowError('edit_locked', 'Документ на проверке: отзовите его, чтобы вносить правки');
    }
    throw new WorkflowError('bad_transition', 'Это действие недоступно при нынешнем статусе документа');
  }
  return next;
}

export const can = (status: DocStatus, event: WorkflowEvent): boolean => TABLE[status][event] !== undefined;

export interface Actions {
  edit: boolean;
  submit: boolean;
  withdraw: boolean;
  /** Кнопки «Имитировать ответ бухгалтера» (демо): только пока документ на проверке */
  simulate: boolean;
}

export function actionsFor(status: DocStatus): Actions {
  return {
    edit: can(status, 'edit'),
    submit: can(status, 'submit'),
    withdraw: can(status, 'withdraw'),
    simulate: status === 'review',
  };
}

/** Получатели, которым можно отправить документ: бухгалтер и финансовый директор. */
export const REVIEWER_IDS = ['demo-accountant', 'demo-cfo'] as const;
