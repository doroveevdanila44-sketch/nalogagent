/**
 * Имя и заголовки файла документа. Без серверных зависимостей: имя на карточке файла в интерфейсе
 * и имя в Content-Disposition строятся одной функцией, поэтому совпадают до символа.
 */

export type FileKind = 'docx' | 'xlsx';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const mimeOf = (kind: FileKind): string => (kind === 'xlsx' ? XLSX_MIME : DOCX_MIME);

/** Знаки, которых нет в именах файлов Windows, и управляющие символы. «Кавычки-ёлочки» допустимы. */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
const MAX_STEM = 150;

/**
 * «Договор аренды без экипажа, ИП Бета.docx»: название документа и расширение. Для версии из
 * истории добавляется « (версия N)», чтобы файлы разных версий не перезаписывали друг друга.
 */
export function documentFileName(title: string, kind: FileKind, version: number | null = null): string {
  const stem = title
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_STEM)
    .replace(/[.\s]+$/, '');
  return `${stem || 'Документ'}${version ? ` (версия ${version})` : ''}.${kind}`;
}

/**
 * Content-Disposition с именем по-русски: filename*= по RFC 5987 и запасное ASCII-имя для клиентов,
 * которые его не понимают. inline: просмотр во встроенном просмотрщике (iPhone, iPad),
 * attachment: сохранение файла (компьютер).
 */
export function contentDisposition(name: string, mode: 'inline' | 'attachment'): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${mode}; filename="document${ext}"; filename*=UTF-8''${encoded}`;
}
