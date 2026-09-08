import React, { useEffect, useState } from 'react';

/**
 * Полоса состояния связи — на всё приложение, а не только на переписку.
 *
 * Раньше она жила в шапке чата, и человек, сидящий на «Главной», в задачах или
 * в календаре, не видел ничего: разделы просто переставали отвечать. Жалоба с
 * прода 08.09.2026 — «главное визуально обозначить, когда связи нет или долго
 * загружается».
 *
 * Отдельно про «долго». Мгновенная надпись «соединение…» на каждый переход
 * мигала бы без всякой пользы: обычное подключение занимает доли секунды.
 * Поэтому полоса про соединение появляется, только если оно затянулось, —
 * порог ниже. А «нет интернета» и «сеанс недействителен» показываются сразу:
 * это не задержка, это состояние, из которого само ничего не выйдет.
 */
export type ConnectionState =
  | 'connected'
  | 'connecting'
  | 'offline'
  | 'server-unavailable'
  | 'session-invalid';

/**
 * Сколько ждать, прежде чем сказать «соединяемся».
 *
 * Полторы секунды: короче — мигает при каждом обычном переподключении, длиннее
 * — человек успевает решить, что приложение зависло.
 */
const SLOW_AFTER_MS = 1500;

/** Сколько ждать, прежде чем признать, что это уже не «чуть дольше». */
const VERY_SLOW_AFTER_MS = 8000;

interface Props {
  state: ConnectionState;
  /** «Войти заново» — единственное состояние, из которого есть выход. */
  onRelogin: () => void;
}

const ConnectionStrip: React.FC<Props> = ({ state, onRelogin }) => {
  const [waited, setWaited] = useState(0);

  useEffect(() => {
    if (state === 'connected') { setWaited(0); return undefined; }
    setWaited(0);
    const started = Date.now();
    const timer = setInterval(() => setWaited(Date.now() - started), 500);
    return () => clearInterval(timer);
  }, [state]);

  if (state === 'connected') return null;
  // Пока не затянулось — молчим: короткое переподключение человека не касается.
  if (state === 'connecting' && waited < SLOW_AFTER_MS) return null;

  const text = state === 'offline'
    ? 'Нет интернета. Сообщения останутся в очереди и уйдут, когда связь вернётся.'
    : state === 'session-invalid'
      ? 'Сеанс больше не действителен — войдите заново.'
      : state === 'server-unavailable'
        ? 'Сервер недоступен. Пробуем переподключиться…'
        : waited >= VERY_SLOW_AFTER_MS
          ? 'Связь очень медленная. Приложение работает, но данные идут дольше обычного.'
          : 'Соединение…';

  return (
    <div className={`connection-strip is-${state}`} role="status" aria-live="polite">
      <span className="connection-strip-dot" aria-hidden="true" />
      <span className="connection-strip-text">{text}</span>
      {state === 'session-invalid' && (
        <button type="button" className="connection-strip-action" onClick={onRelogin}>
          Войти заново
        </button>
      )}
    </div>
  );
};

export default ConnectionStrip;
