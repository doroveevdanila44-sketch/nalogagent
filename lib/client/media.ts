import { useSyncExternalStore } from 'react';

/**
 * Совпадение медиазапроса с подпиской на изменение окна. На сервере и до гидратации false.
 * Нужен там, где два вида компонента не должны одновременно лежать в DOM (иначе дубли
 * заголовков и текста для читалок и тестов), а CSS display: none этого не решает.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', notify);
      return () => mql.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
