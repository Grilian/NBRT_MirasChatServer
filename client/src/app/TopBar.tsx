import React, { useEffect, useRef, useState } from 'react';
import Avatar from '@/shared/ui/Avatar';
import {
  SEARCH_LIMIT, SearchHit, SearchTarget, searchTargets,
} from '@/features/search/globalSearch';

/**
 * Верхняя панель приложения: марка, глобальный поиск, свой аватар.
 *
 * Панель занимает ВСЮ ширину над рельсом и содержимым — так в концепции, и
 * так правильно: марка и поиск относятся к приложению целиком, а не к
 * открытому разделу. Раздел рисует свой заголовок сам, ниже.
 *
 * Панель есть только на десктопе. На телефоне её нет вовсе: там навигация
 * снизу, у каждого раздела своя шапка, а 52px сверху — это шестнадцатая часть
 * экрана, отданная под то, до чего большим пальцем всё равно не дотянуться.
 *
 * Колокольчика уведомлений здесь пока НЕТ, хотя в концепции он есть. Открывать
 * ему нечего: центра уведомлений в приложении не существует, а кнопка,
 * которая ничего не делает, неотличима от сломанной — на этом в проекте уже
 * обжигались со скачиванием файлов на Android. Появится центр — появится и
 * колокольчик.
 */
interface TopBarProps {
  /** Куда можно перейти поиском: чаты, группы, каналы, люди. */
  targets: SearchTarget[];
  onPick: (hit: SearchHit) => void;
  /** Своё имя и аватар — кнопка открывает меню приложения. */
  selfName: string;
  selfAvatarPath?: string | null;
  online?: boolean;
  onOpenMenu: () => void;
  menuOpen?: boolean;
}

/** Марка в интерфейсе пишется по-русски — продукт называется так везде,
 *  кроме имён пакетов и файлов сборки. */
const BRAND = 'МирасЧат';

const KIND_LABEL: Record<SearchTarget['kind'], string> = {
  chat: 'Переписка',
  group: 'Группа',
  channel: 'Канал',
  person: 'Сотрудник',
  service: 'Раздел',
};

const TopBar: React.FC<TopBarProps> = ({
  targets, onPick, selfName, selfAvatarPath, online, onOpenMenu, menuOpen = false,
}) => {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const hits = open ? searchTargets(targets, query, SEARCH_LIMIT) : [];

  // Подсветка возвращается на первую строку при каждой смене запроса: иначе
  // после сужения выдачи Enter отправлял бы туда, куда человек не смотрит.
  useEffect(() => { setActive(0); }, [query]);

  // Клик мимо закрывает выдачу, но НЕ стирает запрос: человек мог отвлечься
  // на другое окно, и потерять набранное из-за этого он не должен.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (hit: SearchHit) => {
    onPick(hit);
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      // Первый Escape убирает выдачу, второй — очищает поле. Сразу очищать
      // нельзя: чаще всего промахнулись строкой, а не запросом.
      if (open && hits.length) setOpen(false);
      else setQuery('');
      return;
    }
    if (!hits.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % hits.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + hits.length) % hits.length); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(hits[active]); }
  };

  return (
    <header className="top-bar">
      <div className="top-bar-brand">
        <span className="roundel roundel-sm" aria-hidden="true">М</span>
        <span className="top-bar-wordmark">{BRAND}</span>
      </div>

      <div className="top-bar-search" ref={boxRef}>
        <svg className="top-bar-search-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          className="top-bar-search-field"
          /* Подпись честная. В концепции поле называется «Поиск по
             МирасЧату», но поиска по сообщениям на сервере ещё нет, и обещать
             его подписью — значит отправить человека искать то, чего поле не
             найдёт. Переименуем вместе с появлением поиска по переписке. */
          placeholder="Чаты, люди и группы"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls="top-bar-search-results"
          aria-label="Поиск по чатам, людям и группам"
        />
        {hits.length > 0 && (
          <ul className="top-bar-results" id="top-bar-search-results" role="listbox">
            {hits.map((hit, i) => (
              <li key={hit.kind + hit.chatId} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  className={'top-bar-result' + (i === active ? ' is-active' : '')}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(hit)}
                >
                  <Avatar
                    name={hit.name}
                    avatarPath={hit.avatarPath}
                    size="sm"
                    online={hit.online}
                    isGroup={hit.kind === 'group' || hit.kind === 'channel'}
                  />
                  <span className="top-bar-result-body">
                    <span className="top-bar-result-name">{hit.name}</span>
                    <span className="top-bar-result-detail">
                      {KIND_LABEL[hit.kind]}
                      {hit.matched === 'username' && hit.username ? ` · @${hit.username}` : ''}
                      {hit.matched === 'detail' && hit.detail ? ` · ${hit.detail}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {open && query.trim() !== '' && hits.length === 0 && (
          <div className="top-bar-results top-bar-results-empty">
            Ничего не нашлось. Поиск по тексту сообщений пока не работает.
          </div>
        )}
      </div>

      <button
        type="button"
        className={'top-bar-self' + (menuOpen ? ' is-open' : '')}
        onClick={onOpenMenu}
        aria-label="Меню приложения"
        aria-expanded={menuOpen}
        aria-haspopup="dialog"
        title="Меню приложения"
      >
        <Avatar name={selfName} avatarPath={selfAvatarPath} size="sm" online={online} />
      </button>
    </header>
  );
};

export default TopBar;
