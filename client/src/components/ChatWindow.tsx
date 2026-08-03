import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { nameFor } from '../utils/user';
import { formatDaySeparator, formatMoscowTime, moscowDayKey } from '../utils/time';
import { onKeyboardShow } from '../utils/mobileKeyboard';
import { resolveUploadUrl } from '../utils/uploads';

interface Message {
  id: number;
  text: string;
  file_path?: string | null;
  file_width?: number | null;
  file_height?: number | null;
  sender_id: number;
  username: string;
  display_name?: string | null;
  created_at: string;
  status?: 'sent' | 'delivered' | 'read';
  edited_at?: string | null;
  deleted?: boolean | number;
}

interface ChatWindowProps {
  chatId: string | null;
  messages: Message[];
  currentUserId: number;
  /** Показывать имя автора над сообщением — нужно только в общем чате */
  showAuthors?: boolean;
  onScrollTop?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  /** Непрочитанные в этом чате — цифра на кнопке «вниз», как в Telegram */
  unreadCount?: number;
  /** Начать правку — текст уезжает в поле ввода (см. startEdit). */
  onStartEdit: (id: number, text: string) => void;
  /** Сообщение, которое сейчас правят, — подсвечиваем его в ленте. */
  editingId?: number | null;
  onDeleteMessage: (id: number) => void;
  /** Создатель группы может удалять чужие сообщения — не только свои. */
  canDeleteAnyMessage?: boolean;
  onDeleteMessages?: (ids: number[]) => void;
}

const LONG_PRESS_MS = 450;

// Идущие подряд сообщения одного человека Telegram склеивает в блок: имя
// показывается один раз сверху, «хвостик» — только у последнего. Разрыв
// больше пяти минут считаем новым блоком, даже если писал тот же человек.
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function TickIcon({ status }: { status: 'sent' | 'delivered' | 'read' }) {
  const doubleTick = status === 'delivered' || status === 'read';
  return (
    <span className={'ticks' + (status === 'read' ? ' read' : '')}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        {doubleTick ? (
          <><path d="m1 13 4 4L15 7" /><path d="m9 13 4 4L23 7" /></>
        ) : (
          <path d="m4 13 5 5L20 7" />
        )}
      </svg>
    </span>
  );
}

interface RenderedRow {
  message: Message;
  /** Первое сообщение в блоке одного автора — над ним подпись автора */
  startsGroup: boolean;
  /** Последнее сообщение в блоке — у него рисуется хвостик пузыря */
  endsGroup: boolean;
  /** Разделитель дня перед этим сообщением */
  daySeparator: string | null;
}

function buildRows(messages: Message[]): RenderedRow[] {
  return messages.map((message, index) => {
    const prev = index > 0 ? messages[index - 1] : null;
    const next = index < messages.length - 1 ? messages[index + 1] : null;

    const dayKey = moscowDayKey(message.created_at);
    const prevDayKey = prev ? moscowDayKey(prev.created_at) : null;
    const newDay = dayKey !== prevDayKey;

    const time = new Date(message.created_at).getTime();
    const groupsWithPrev = !!prev
      && !newDay
      && prev.sender_id === message.sender_id
      && time - new Date(prev.created_at).getTime() < GROUP_WINDOW_MS;
    const groupsWithNext = !!next
      && moscowDayKey(next.created_at) === dayKey
      && next.sender_id === message.sender_id
      && new Date(next.created_at).getTime() - time < GROUP_WINDOW_MS;

    return {
      message,
      startsGroup: !groupsWithPrev,
      endsGroup: !groupsWithNext,
      daySeparator: newDay ? formatDaySeparator(message.created_at) : null,
    };
  });
}

const ChatWindow: React.FC<ChatWindowProps> = ({
  chatId, messages: rawMessages, currentUserId, showAuthors, onScrollTop, hasMore, loadingMore, unreadCount,
  onStartEdit, editingId, onDeleteMessage, canDeleteAnyMessage, onDeleteMessages
}) => {
  // Удалённое сообщение хранится на сервере (обязательство по закону — до
  // 3 лет метаданные о факте передачи), но в переписке не должно быть видно
  // вообще, включая плейсхолдер "Сообщение удалено" — поэтому просто не
  // рендерим такие строки, а не показываем их пустым пузырём.
  const messages = rawMessages.filter((m) => !m.deleted);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [shouldScrollToBottom, setShouldScrollToBottom] = useState(true);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const prevMessagesLengthRef = useRef(0);

  const [menuFor, setMenuFor] = useState<{ id: number; x: number; y: number } | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Режим выбора доступен всем — свои сообщения может отметить кто угодно,
  // чужие может отметить только владелец группы (canDeleteAnyMessage). При
  // уходе из чата и на смену прав гасим его, а не оставляем висеть с чужими id.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Позиция прокрутки на момент запроса следующей страницы истории —
  // подробности в useLayoutEffect ниже.
  const pendingRestoreRef = useRef<{ height: number; top: number } | null>(null);

  useEffect(() => {
    if (messages.length === 0) return;

    if (messages.length > prevMessagesLengthRef.current) {
      if (shouldScrollToBottom) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      }
    }

    prevMessagesLengthRef.current = messages.length;
  }, [messages, shouldScrollToBottom]);

  // Появление экранной клавиатуры на Android физически уменьшает высоту
  // WebView (adjustResize) — flex-раскладка тут же сжимает conv-body под
  // новый размер, но её scrollTop остаётся прежним числом. Раньше «дно»
  // ленты просто уезжало под новый нижний край: последние сообщения
  // оказывались за пределами видимой области, и добраться до них можно было
  // только ручной прокруткой. Довозвращаем прокрутку к концу сами — и только
  // если человек и так были внизу: если он читает историю выше, набор
  // сообщения не должен выдёргивать его обратно к последним репликам.
  const shouldScrollRef = useRef(shouldScrollToBottom);
  shouldScrollRef.current = shouldScrollToBottom;

  useEffect(() => {
    return onKeyboardShow(() => {
      if (!shouldScrollRef.current) return;
      // Двойной rAF: колбэк плагина срабатывает раньше, чем WebView
      // фактически перестроился под новую высоту (scrollHeight ещё старый) —
      // один кадр на применение резайза, второй на коммит разметки.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
        });
      });
    });
  }, []);

  // Подгрузка истории добавляет сообщения СВЕРХУ, из-за чего содержимое
  // уезжает вниз, а прокрутка остаётся на месте — визуально это выглядело
  // как прыжок к совсем другому куску переписки, и читать историю было
  // невозможно. Возвращаем прокрутку к тому же сообщению: смещаем её ровно
  // на прирост высоты. useLayoutEffect — чтобы поправить до отрисовки кадра
  // и человек не увидел скачка.
  useLayoutEffect(() => {
    const pending = pendingRestoreRef.current;
    const container = messagesContainerRef.current;
    if (!pending || !container) return;
    if (container.scrollHeight <= pending.height) return;

    container.scrollTop = container.scrollHeight - pending.height + pending.top;
    pendingRestoreRef.current = null;
  }, [messages]);

  useEffect(() => {
    setShouldScrollToBottom(true);
    setShowJumpButton(false);
    prevMessagesLengthRef.current = 0;
    pendingRestoreRef.current = null;
    setMenuFor(null);
    setSelectMode(false);
    setSelectedIds(new Set());
  }, [chatId]);

  // Закрытие контекстного меню по клику снаружи
  useEffect(() => {
    if (!menuFor) return;
    const onDocClick = (e: Event) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuFor(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('touchstart', onDocClick);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('touchstart', onDocClick);
    };
  }, [menuFor]);

  // Меню открывается ровно в точке клика/долгого нажатия — у сообщения
  // близко к правому или нижнему краю экрана оно раньше вылезало за
  // видимую область (особенно у своих реплик, прижатых вправо). Подправляем
  // после первой отрисовки, когда уже известны реальные размеры меню:
  // если что-то не помещается, отодвигаем ровно настолько, чтобы влезло.
  useLayoutEffect(() => {
    if (!menuFor || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const overflowX = rect.right - window.innerWidth;
    const overflowY = rect.bottom - window.innerHeight;
    if (overflowX <= 0 && overflowY <= 0) return;

    setMenuFor((prev) => prev && ({
      ...prev,
      x: overflowX > 0 ? Math.max(4, prev.x - overflowX) : prev.x,
      y: overflowY > 0 ? Math.max(4, prev.y - overflowY) : prev.y,
    }));
  }, [menuFor]);

  const handleScroll = () => {
    if (!messagesContainerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setShouldScrollToBottom(isAtBottom);
    setShowJumpButton(scrollHeight - scrollTop - clientHeight > 300);

    if (scrollTop < 150 && onScrollTop && hasMore && !loadingMore) {
      pendingRestoreRef.current = { height: scrollHeight, top: scrollTop };
      onScrollTop();
    }
  };

  const jumpToBottom = () => {
    setShouldScrollToBottom(true);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Раньше меню открывалось только на своих сообщениях — скопировать текст
  // чужой реплики было нельзя вовсе. Теперь оно доступно на любом
  // непустом сообщении; какие пункты в нём показать (только «Копировать»
  // или ещё и «Редактировать»/«Удалить»), решает уже сам рендер меню по
  // мере сравнения sender_id с currentUserId.
  const openMenuAt = (msg: Message, x: number, y: number) => {
    if (selectMode) return;
    setMenuFor({ id: msg.id, x, y });
  };

  const handleContextMenu = (e: React.MouseEvent, msg: Message) => {
    e.preventDefault();
    openMenuAt(msg, e.clientX, e.clientY);
  };

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleTouchStart = (e: React.TouchEvent, msg: Message) => {
    const touch = e.touches[0];
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      openMenuAt(msg, touch.clientX, touch.clientY);
    }, LONG_PRESS_MS);
  };

  const startEdit = (msg: Message) => {
    // Редактирование живёт в поле ввода, а не в самом пузыре: у длинного
    // сообщения строчка внутри пузыря превращалась в щель на пару слов, где
    // текст не помещался и его нельзя было толком просмотреть. Как в Telegram:
    // над полем ввода появляется панель «Редактирование», а сам текст
    // подставляется в обычное поле, которое умеет расти и переносить строки.
    onStartEdit(msg.id, msg.text);
    setMenuFor(null);
  };

  const confirmDelete = (id: number) => {
    setMenuFor(null);
    if (window.confirm('Удалить сообщение без возможности восстановления?')) {
      onDeleteMessage(id);
    }
  };

  useEffect(() => {
    if (!lightboxUrl) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxUrl(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxUrl]);

  const copyMessageText = (msg: Message) => {
    setMenuFor(null);
    navigator.clipboard?.writeText(msg.text).catch((e) => console.error('Не удалось скопировать:', e));
  };

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const confirmBulkDelete = () => {
    if (selectedIds.size === 0 || !onDeleteMessages) return;
    if (window.confirm(`Удалить выбранные сообщения (${selectedIds.size}) без возможности восстановления?`)) {
      onDeleteMessages(Array.from(selectedIds));
      exitSelectMode();
    }
  };

  if (!chatId) {
    return (
      <div className="conv-empty">
        <div className="conv-empty-badge">Выберите чат, чтобы начать переписку</div>
      </div>
    );
  }

  const rows = buildRows(messages);

  return (
    <div className="conv-wrap">
      {!selectMode && messages.length > 0 && (
        <button type="button" className="select-messages-btn" onClick={() => setSelectMode(true)} title="Выбрать сообщения">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
        </button>
      )}
      {selectMode && (
        <div className="select-toolbar">
          <button type="button" className="icon-btn" onClick={exitSelectMode} aria-label="Отмена">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
          <span className="select-toolbar-count">Выбрано: {selectedIds.size}</span>
          <button type="button" className="select-toolbar-delete" onClick={confirmBulkDelete} disabled={selectedIds.size === 0}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
            Удалить
          </button>
        </div>
      )}
      <div
        ref={messagesContainerRef}
        className="conv-body"
        onScroll={handleScroll}
      >
        {loadingMore && <div className="load-more-hint">Загрузка…</div>}
        {messages.length === 0 && !loadingMore && (
          <div className="conv-empty-inline">
            <div className="conv-empty-badge">Сообщений пока нет</div>
          </div>
        )}

        {rows.map(({ message: msg, startsGroup, endsGroup, daySeparator }) => {
          const mine = msg.sender_id === currentUserId;
          const isEditing = editingId === msg.id;
          // В режиме выбора отмечать можно своё сообщение всегда, а чужое —
          // только владельцу группы (см. canDeleteAnyMessage в Chat.tsx).
          const selectable = mine || !!canDeleteAnyMessage;

          const isSelected = selectedIds.has(msg.id);
          const className = [
            'msg',
            mine ? 'mine' : 'theirs',
            startsGroup ? 'starts-group' : '',
            endsGroup ? 'ends-group' : '',
            selectMode && selectable ? 'is-selectable' : '',
            isSelected ? 'is-selected' : '',
            isEditing ? 'is-editing' : '',
          ].filter(Boolean).join(' ');

          return (
            <React.Fragment key={msg.id}>
              {daySeparator && <div className="date-sep">{daySeparator}</div>}
              <div
                className={className}
                onClick={selectMode && selectable ? () => toggleSelected(msg.id) : undefined}
                onContextMenu={!selectMode ? (e) => handleContextMenu(e, msg) : undefined}
                onTouchStart={!selectMode ? (e) => handleTouchStart(e, msg) : undefined}
                onTouchEnd={!selectMode ? clearLongPress : undefined}
                onTouchMove={!selectMode ? clearLongPress : undefined}
              >
                {selectMode && selectable && (
                  <input type="checkbox" className="msg-select-check" checked={isSelected} readOnly />
                )}
                <div className="bubble">
                    {/* Имя автора — только в общем чате и только над первым
                        сообщением блока: в переписке один на один оно
                        повторяло бы имя из шапки на каждой реплике. */}
                    {!mine && showAuthors && startsGroup && (
                      <div className="bubble-author">{nameFor(msg)}</div>
                    )}
                    {msg.file_path && (
                      <button
                        type="button"
                        className="bubble-image"
                        style={msg.file_width && msg.file_height ? { aspectRatio: `${msg.file_width} / ${msg.file_height}` } : undefined}
                        onClick={() => setLightboxUrl(resolveUploadUrl(msg.file_path))}
                      >
                        <img src={resolveUploadUrl(msg.file_path) || ''} alt="" />
                      </button>
                    )}
                    {msg.text && <span className="bubble-text">{msg.text}</span>}
                    {/* Время и галочки — внутри пузыря, как в Telegram:
                        обтекаются текстом и не занимают отдельную строку. */}
                    <span className="bubble-meta">
                      {msg.edited_at && <span className="edited-label">изм.</span>}
                      <span className="bubble-time">{formatMoscowTime(msg.created_at)}</span>
                      {mine && <TickIcon status={msg.status || 'sent'} />}
                    </span>
                </div>
              </div>
            </React.Fragment>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {showJumpButton && (
        <button type="button" className="jump-to-bottom" onClick={jumpToBottom} aria-label="К последним сообщениям">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M19 12l-7 7-7-7" />
          </svg>
          {!!unreadCount && unreadCount > 0 && <span className="jump-badge">{unreadCount}</span>}
        </button>
      )}

      {menuFor && (() => {
        const menuMsg = messages.find(m => m.id === menuFor.id);
        if (!menuMsg) return null;
        const menuMine = menuMsg.sender_id === currentUserId;

        return (
          <div
            ref={menuRef}
            className="msg-context-menu"
            style={{ left: menuFor.x, top: menuFor.y }}
          >
            {/* Копировать — на любом сообщении, не только своём: раньше меню
                вообще не открывалось на чужих репликах. У картинки без
                подписи копировать нечего — текста в сообщении просто нет. */}
            {menuMsg.text && (
              <button type="button" onClick={() => copyMessageText(menuMsg)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                Копировать
              </button>
            )}
            {menuMine && (
              <>
                <button type="button" onClick={() => startEdit(menuMsg)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                  Редактировать
                </button>
                <button type="button" className="danger" onClick={() => confirmDelete(menuFor.id)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
                  Удалить
                </button>
              </>
            )}
          </div>
        );
      })()}

      {lightboxUrl && (
        <div className="lightbox-overlay" onClick={() => setLightboxUrl(null)}>
          <button type="button" className="lightbox-close" onClick={() => setLightboxUrl(null)} aria-label="Закрыть">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
          <img src={lightboxUrl} alt="" className="lightbox-img" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
};

export default ChatWindow;
