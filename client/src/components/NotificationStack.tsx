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
  title: string;
  body: string;
  avatarPath?: string | null;
  isGeneral?: boolean;
  /** Сколько сообщений из этого чата слилось в это уведомление */
  count: number;
  /** Растёт при каждом новом сообщении в стопку — перезапускает таймер показа */
  revision: number;
}

interface NotificationStackProps {
  toasts: ToastNotification[];
  /** 0 — не скрывать автоматически */
  durationMs: number;
  onOpen: (chatId: string) => void;
  onDismiss: (chatId: string) => void;
}

interface ToastCardProps {
  toast: ToastNotification;
  durationMs: number;
  onOpen: (chatId: string) => void;
  onDismiss: (chatId: string) => void;
}

const ToastCard: React.FC<ToastCardProps> = ({ toast, durationMs, onOpen, onDismiss }) => {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(durationMs);
  const startedAtRef = useRef(Date.now());

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
    const timer = setTimeout(() => onDismiss(toast.chatId), remainingRef.current);

    return () => {
      clearTimeout(timer);
      // При наведении мышью таймер снимается — запоминаем, сколько осталось,
      // чтобы после ухода курсора досчитать остаток, а не начать сначала.
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
    };
  }, [toast.revision, toast.chatId, durationMs, paused, onDismiss]);

  return (
    <div
      className="toast"
      role="alert"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <button type="button" className="toast-main" onClick={() => onOpen(toast.chatId)}>
        <Avatar name={toast.title} avatarPath={toast.avatarPath} isGeneral={toast.isGeneral} />
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
        onClick={() => onDismiss(toast.chatId)}
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
          key={toast.chatId}
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
