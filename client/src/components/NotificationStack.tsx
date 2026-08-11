import React, { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar';

// Всплывающие уведомления внутри приложения — то, что человек видит, когда
// окно открыто, но он смотрит в другой чат или просто отошёл. Системного
// уведомления ОС для этого мало: оно короткое, его легко пропустить, а в
// части конфигураций (запрещены в настройках Windows, «Не беспокоить»,
// отключены для браузера) его не будет вообще. Поэтому свой стек — он всегда
// работает, всегда заметен и висит ровно столько, сколько задал пользователь.

export interface ToastNotification {
  /** Ключ стопки — один чат даёт одно уведомление, как в Telegram */
  chatId: string;
  threadRootId?: number;
  title: string;
  body: string;
  avatarPath?: string | null;
  isGeneral?: boolean;
  isGroup?: boolean;
  /** Сколько сообщений из этого чата слилось в это уведомление */
  count: number;
  /** Растёт при каждом новом сообщении в стопку — перезапускает таймер показа */
  revision: number;
}

interface NotificationStackProps {
  toasts: ToastNotification[];
  /** 0 — не скрывать автоматически */
  durationMs: number;
  onOpen: (chatId: string, threadRootId?: number) => void;
  onDismiss: (chatId: string, threadRootId?: number) => void;
}

interface ToastCardProps {
  toast: ToastNotification;
  durationMs: number;
  onOpen: (chatId: string, threadRootId?: number) => void;
  onDismiss: (chatId: string, threadRootId?: number) => void;
}

// Смахивание вверх закрывает уведомление — жест того же типа, что и в
// системных шторках. Порог в пикселях, а не в скорости: жест короткий,
// скорость на телефоне слишком шумно измерять на паре событий touchmove.
const SWIPE_DISMISS_PX = 48;
// Ниже этого сдвига касание всё ещё считается тапом «открыть чат»: палец
// никогда не стоит на месте идеально, и дрожание не должно съедать клик.
const TAP_SLOP_PX = 8;

const ToastCard: React.FC<ToastCardProps> = ({ toast, durationMs, onOpen, onDismiss }) => {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(durationMs);
  const startedAtRef = useRef(Date.now());

  const touchStartY = useRef<number | null>(null);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    setDragging(true);
    setPaused(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    const delta = e.touches[0].clientY - touchStartY.current;
    // Только вверх: вниз/в стороны — не наш жест, оставляем на месте.
    setDragY(Math.min(0, delta));
  };

  const endDrag = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    touchStartY.current = null;
    setDragging(false);
    setPaused(false);

    // Палец заметно двигали — это смахивание, а не тап. Гасим синтетический
    // click, который браузер шлёт следом: он приходится по карточке и открыл
    // бы чат, хотя уведомление именно что убирали.
    if (-dragY > TAP_SLOP_PX) e.preventDefault();

    if (-dragY > SWIPE_DISMISS_PX) onDismiss(toast.chatId, toast.threadRootId);
    else setDragY(0);
  };

  // Порядок эффектов важен: сначала сбрасываем остаток времени (новое
  // сообщение в ту же стопку = показ начинается заново), потом заводим
  // таймер. Оба зависят от revision, поэтому пересчитываются вместе.
  useEffect(() => {
    remainingRef.current = durationMs;
  }, [toast.revision, durationMs]);

  useEffect(() => {
    if (durationMs <= 0) return; // «Не скрывать» — ждём действия человека
    if (paused) return;

    startedAtRef.current = Date.now();
    // threadRootId обязателен и здесь: получатель ищет тост по паре
    // (chatId, threadRootId), и без него автоскрытие/смахивание тоста ветки
    // не находило бы его вовсе — закрыть можно было бы только крестиком.
    const timer = setTimeout(() => onDismiss(toast.chatId, toast.threadRootId), remainingRef.current);

    return () => {
      clearTimeout(timer);
      // При наведении мышью таймер снимается — запоминаем, сколько осталось,
      // чтобы после ухода курсора досчитать остаток, а не начать сначала.
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
    };
  }, [toast.revision, toast.chatId, toast.threadRootId, durationMs, paused, onDismiss]);

  return (
    <div
      className={'toast' + (dragging ? ' is-dragging' : '')}
      role="alert"
      style={dragY < 0 ? {
        transform: `translateY(${dragY}px)`,
        opacity: Math.max(0, 1 - -dragY / (SWIPE_DISMISS_PX * 2.5)),
      } : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={endDrag}
      onTouchCancel={endDrag}
    >
      <button type="button" className="toast-main" onClick={() => onOpen(toast.chatId, toast.threadRootId)}>
        <Avatar name={toast.title} avatarPath={toast.avatarPath} isGeneral={toast.isGeneral} isGroup={toast.isGroup} />
        <div className="toast-text">
          <div className="toast-title">{toast.title}</div>
          <div className="toast-body">{toast.body}</div>
          {toast.count > 1 && (
            <div className="toast-count">
              {toast.count} {pluralMessages(toast.count)}
            </div>
          )}
        </div>
      </button>

      <button
        type="button"
        className="toast-close"
        aria-label="Закрыть уведомление"
        onClick={() => onDismiss(toast.chatId, toast.threadRootId)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>

      {durationMs > 0 && (
        <span
          key={toast.revision}
          className="toast-progress"
          style={{ animationDuration: `${durationMs}ms`, animationPlayState: paused ? 'paused' : 'running' }}
        />
      )}
    </div>
  );
};

function pluralMessages(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'новое сообщение';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'новых сообщения';
  return 'новых сообщений';
}

const NotificationStack: React.FC<NotificationStackProps> = ({ toasts, durationMs, onOpen, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <ToastCard
          key={toast.threadRootId ? `thread_${toast.threadRootId}` : toast.chatId}
          toast={toast}
          durationMs={durationMs}
          onOpen={onOpen}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
};

export default NotificationStack;
