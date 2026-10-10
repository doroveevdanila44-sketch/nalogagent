/**
 * В JavaScript \b и \w не знают кириллицу (только ASCII). Этот помощник переводит шаблон,
 * написанный с \b и \w, в Unicode-корректный: \w это буква кириллицы или латиницы, цифра, подчёркивание;
 * \b в начале слова это «не после буквы», в конце слова «не перед буквой».
 * Шаблоны пишутся для текста после normalize(): нижний регистр, ё заменена на е.
 */
const WORD = 'а-яa-z0-9_';

export function cyr(source: string, flags = ''): RegExp {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const two = source.slice(i, i + 2);
    if (two === '\\w') {
      out += `[${WORD}]`;
      i++;
    } else if (two === '\\b') {
      const prev = source[i - 1];
      const atStart = i === 0 || prev === '(' || prev === '|' || prev === '^' || prev === ' ';
      out += atStart ? `(?<![${WORD}])` : `(?![${WORD}])`;
      i++;
    } else if (source[i] === '\\') {
      out += two;
      i++;
    } else {
      out += source[i];
    }
  }
  return new RegExp(out, flags);
}
