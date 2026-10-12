import type { Period } from '@/lib/calc/period';
import type { RenderBlock } from './render';
import type {
  CommentInfo,
  DocStatus,
  EventInfo,
  FieldValues,
  TemplateCategory,
  TemplateField,
  VersionInfo,
} from './types';

/**
 * Документ для страницы-листа: блоки текста с полями (те же, из которых собираются .docx и .xlsx),
 * источники значений, недостающие поля, версии, комментарии и история.
 */
export interface DocumentDetail {
  id: string;
  templateKey: string;
  title: string;
  category: TemplateCategory;
  status: DocStatus;
  /** Нынешняя версия документа */
  version: number;
  /** Версия, которую показывает страница (старую править нельзя) */
  shownVersion: number;
  entityId: string | null;
  entityName: string | null;
  period: Period | null;
  periodLabel: string | null;
  output: 'docx' | 'xlsx';
  /** Имя файла показанной версии: то же, что в Content-Disposition */
  fileName: string;
  /** Когда обновлён документ (для старой версии: когда она создана) */
  updatedAt: string;
  fields: TemplateField[];
  values: FieldValues;
  /** Текст документа блоками: заголовки, абзацы, пункты, таблицы; в них поля с состоянием и источником */
  blocks: RenderBlock[];
  /** Откуда взято значение каждого поля: для чек-листа и подсказок */
  sources: Record<string, string>;
  hash: string;
  /** Ключи пропущенных обязательных полей */
  missing: string[];
  /** Сколько снимков расчёта в версии: для значка «Показать расчёт» */
  calcCount: number;
  versions: VersionInfo[];
  comments: CommentInfo[];
  events: EventInfo[];
  reviewer: { id: string; name: string; role: string } | null;
  can: { edit: boolean; submit: boolean; withdraw: boolean; simulate: boolean };
  tz: string;
  readOnly: boolean;
}
