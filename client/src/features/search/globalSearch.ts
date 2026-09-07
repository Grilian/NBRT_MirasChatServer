/**
 * Глобальный поиск в верхней панели.
 *
 * Отвечает на вопрос «куда перейти»: чаты, группы, каналы и люди из
 * справочника. Поиск ПО СООБЩЕНИЯМ сюда пока не входит — его нет на сервере
 * вовсе (числится в незакрытых вопросах), и подписывать поле «Поиск по
 * МирасЧату», пока оно ищет только названия, значит обещать несделанное.
 *
 * Матчинг вынесен из компонента отдельным модулем не ради красоты: правила
 * ранжирования — единственное здесь, что можно сделать неправильно незаметно
 * для глаза, и они обязаны проверяться тестом, а не просмотром выдачи.
 */

export type SearchTargetKind = 'chat' | 'group' | 'channel' | 'person' | 'service';

export interface SearchTarget {
  /** Идентификатор чата, куда ведёт строка. */
  chatId: string;
  name: string;
  kind: SearchTargetKind;
  /** Логин — по нему тоже ищем: половина людей помнит именно его. */
  username?: string | null;
  /** Подразделение или должность — вторая строка выдачи. */
  detail?: string | null;
  avatarPath?: string | null;
  userId?: number | null;
  online?: boolean;
}

export interface SearchHit extends SearchTarget {
  /** Чем совпало — по этому полю выдача и подписывается. */
  matched: 'name' | 'username' | 'detail';
}

/** Сколько строк показываем. Больше — это уже не подсказка, а список. */
export const SEARCH_LIMIT = 8;

/**
 * Приведение к сравнимому виду.
 *
 * `ё` → `е` намеренно: половина людей набирает «Семенов», и выдача, молча
 * пустая на «Семёнов», читается как «такого человека нет». Регистр и края —
 * очевидно.
 */
export function normalize(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').trim();
}

/**
 * Ранг совпадения: меньше — выше в выдаче.
 *
 * Порядок именно такой, потому что человек, набирающий три буквы, почти
 * всегда набирает НАЧАЛО того, что ищет. Совпадение с начала слова ценнее
 * совпадения где-то в середине: «ан» обязано сперва показать «Анна», а не
 * «Александр Охотников» ради «ох-ан».
 */
function rankOf(haystack: string, needle: string): number | null {
  const index = haystack.indexOf(needle);
  if (index < 0) return null;
  if (index === 0) return 0;
  // Начало слова: пробел, дефис или точка перед совпадением.
  if (/[\s\-.,/]/.test(haystack[index - 1])) return 1;
  return 2;
}

interface Scored {
  hit: SearchHit;
  rank: number;
  /** Порядок в исходном списке — им разрешаются равные ранги. */
  order: number;
}

/**
 * Ранг по виду строки при прочих равных.
 *
 * Открытая переписка ценнее карточки человека из справочника: если чат уже
 * есть, человек почти наверняка идёт в него, а не заводить второй. Служебные
 * строки («Ветки», «Следы») уходят вниз — их ищут редко и знают, где они.
 */
const KIND_RANK: Record<SearchTargetKind, number> = {
  chat: 0, group: 0, channel: 0, person: 1, service: 2,
};

export function searchTargets(targets: SearchTarget[], query: string, limit = SEARCH_LIMIT): SearchHit[] {
  const needle = normalize(query);
  // Пустой запрос НЕ показывает всё: подсказка на весь справочник — это уже
  // не поиск, а второй список чатов поверх первого.
  if (!needle) return [];

  const scored: Scored[] = [];

  targets.forEach((target, order) => {
    const byName = rankOf(normalize(target.name), needle);
    const byUsername = target.username ? rankOf(normalize(target.username), needle) : null;
    const byDetail = target.detail ? rankOf(normalize(target.detail), needle) : null;

    // Имя всегда выигрывает у логина, логин — у подразделения: это порядок, в
    // котором человек сам себе описывает того, кого ищет.
    let matched: SearchHit['matched'] | null = null;
    let rank = 0;
    if (byName !== null) { matched = 'name'; rank = byName; }
    else if (byUsername !== null) { matched = 'username'; rank = 3 + byUsername; }
    else if (byDetail !== null) { matched = 'detail'; rank = 6 + byDetail; }
    if (matched === null) return;

    scored.push({ hit: { ...target, matched }, rank: rank * 10 + KIND_RANK[target.kind], order });
  });

  scored.sort((a, b) => (a.rank - b.rank) || (a.order - b.order));
  return scored.slice(0, limit).map((s) => s.hit);
}
