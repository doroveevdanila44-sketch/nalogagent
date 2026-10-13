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
 * «Договор аренды автомобиля без экипажа_ИП Бета.docx»: название документа, части через знак
 * подчёркивания (как в «НДС_Альфа_2026-02.xlsx»), и расширение. Для версии из истории добавляется
 * « (версия N)», чтобы файлы разных версий не перезаписывали друг друга.
 */
export function documentFileName(title: string, kind: FileKind, version: number | null = null): string {
  const stem = title
    .split(/,\s+/)
    .map((part) => part.replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '')
    .join('_')
    .slice(0, MAX_STEM)
    .replace(/[._\s]+$/, '');
  return `${stem || 'Документ'}${version ? ` (версия ${version})` : ''}.${kind}`;
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Запасное имя для клиентов без поддержки filename*=: русские буквы латиницей, всё остальное
 * кроме букв, цифр, точки, дефиса и подчёркивания заменено подчёркиванием. Знака процента и кавычек
 * в нём нет, поэтому оно читается человеком, даже если клиент возьмёт именно его.
 */
export function asciiFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).replace(/[^A-Za-z0-9.]/g, '') : '';
  const base = dot > 0 ? name.slice(0, dot) : name;
  const chars = [...base];
  const isUpper = (c: string | undefined) => c !== undefined && c !== c.toLowerCase();
  const latin = chars
    .map((c, i) => {
      const mapped = TRANSLIT[c.toLowerCase()];
      if (mapped === undefined) return c;
      if (!isUpper(c) || mapped === '') return mapped;
      // заглавная: «Ш» это «Sh», в сокращении («НДС», «ИП») все буквы заглавные
      const acronym = isUpper(chars[i - 1]) || isUpper(chars[i + 1]);
      return acronym ? mapped.toUpperCase() : mapped[0]!.toUpperCase() + mapped.slice(1);
    })
    .join('');
  const stem = latin
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return `${stem || 'document'}${ext}`;
}

/**
 * Content-Disposition: filename="latin-name.xlsx"; filename*=UTF-8''<процентное кодирование UTF-8>
 * (RFC 6266, RFC 5987). Клиенты с поддержкой filename* (iOS, macOS, Windows, Android) показывают имя
 * по-русски, остальные берут латинское. Знак процента может стоять только в значении filename*:
 * в обычном filename он показывался бы буквально («%D0%A0...»). inline: просмотр во встроенном
 * просмотрщике, attachment: сохранение файла.
 */
export function contentDisposition(name: string, mode: 'inline' | 'attachment'): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${mode}; filename="${asciiFileName(name)}"; filename*=UTF-8''${encoded}`;
}
