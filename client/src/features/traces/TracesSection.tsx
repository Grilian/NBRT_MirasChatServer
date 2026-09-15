import React, { useCallback, useEffect, useState } from 'react';
import Avatar from '@/shared/ui/Avatar';
import Modal, { ModalHead } from '@/shared/ui/Modal';
import { AUTOFOCUS_ON_OPEN } from '@/shared/hooks/autoFocus';
import { formatChatListTime } from '@/shared/lib/time';
import { fetchTraceOrigin, fetchTraces, saveTraceNote, TraceItem, TraceKind } from './api';

// Раздел «Следы» — сохранённое ПРОИСХОЖДЕНИЕ, а не копии.
//
// Отличие от «Дневника» принципиальное и определяет весь вид
// раздела: там лежат копии, которыми человек распоряжается как сообщениями,
// здесь — ссылки на источник. Поэтому тут нет поля ввода, нельзя ничего
// «дописать», а у каждой строки есть состояние: источник мог быть удалён,
// скрыт самим человеком или закрыт правами. Подробности — docs/decisions/traces.md.

const FILTERS: Array<{ id: TraceKind; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'messages', label: 'Сообщения' },
  { id: 'files', label: 'Файлы' },
  { id: 'links', label: 'Ссылки' },
  { id: 'images', label: 'Изображения' },
  { id: 'notes', label: 'С заметками' },
];

interface TracesSectionProps {
  /** Перейти к источнику: чат открывается окном вокруг искомого сообщения. */
  onOpenMessage: (chatId: string, messageId: number) => void;
  /** Открыть ветку — ответы вырезаны из ленты, и в них ведёт свой путь. */
  onOpenThread?: (rootId: number) => void;
}

/** Почему идти некуда. Формулировки разные не для красоты: причины разные. */
const STATE_COPY: Record<string, { title: string; hint: string }> = {
  cleaned: {
    title: 'Этот след был подчищен',
    hint: 'Исходное сообщение удалено.',
  },
  hidden: {
    title: 'Вы скрыли это сообщение у себя',
    hint: 'У остальных участников оно на месте — перейти к нему можно, только вернув его себе.',
  },
  forbidden: {
    title: 'Нет доступа к исходному месту',
    hint: 'Сообщение лежит там, куда у вас сейчас нет доступа.',
  },
};

const TracesSection: React.FC<TracesSectionProps> = ({ onOpenMessage, onOpenThread }) => {
  const [kind, setKind] = useState<TraceKind>('all');
  const [items, setItems] = useState<TraceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [noteFor, setNoteFor] = useState<TraceItem | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  const load = useCallback(async (next: TraceKind) => {
    setLoading(true);
    try {
      setItems(await fetchTraces(next));
    } catch {
      setNotice('Не удалось загрузить Следы');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(kind); }, [kind, load]);

  // Право проверяется ЗДЕСЬ, а не при показе списка: между открытием раздела и
  // нажатием человека могли вывести из группы, а сообщение — удалить.
  const openOrigin = async (item: TraceItem) => {
    try {
      const origin = await fetchTraceOrigin(item.origin_message_id);
      if (origin.state !== 'ok' || !origin.chat_id || !origin.message_id) {
        setNotice(STATE_COPY[origin.state]?.title || 'Перейти к источнику не удалось');
        // Состояние изменилось с момента загрузки — список обязан это показать.
        load(kind);
        return;
      }
      if (origin.thread_root_id && onOpenThread) {
        onOpenThread(origin.thread_root_id);
        return;
      }
      onOpenMessage(origin.chat_id, origin.message_id);
    } catch {
      setNotice('Перейти к источнику не удалось');
    }
  };

  const submitNote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!noteFor) return;
    const target = noteFor.origin_message_id;
    try {
      const saved = await saveTraceNote(target, noteDraft);
      setItems((prev) => prev.map((i) => (i.origin_message_id === target ? { ...i, note: saved } : i)));
      setNoteFor(null);
      // Фильтр «С заметками» мог перестать подходить этой строке.
      if (kind === 'notes') load(kind);
    } catch {
      setNotice('Заметку не удалось сохранить');
    }
  };

  const preview = (item: TraceItem) => {
    if (item.attachment_archived) return 'Вложение убрано';
    if (item.document_name) return `📎 ${item.document_name}`;
    if (item.text) return item.text;
    if (item.file_path) return 'Фотография';
    return 'Сообщение';
  };

  return (
    <div className="traces-section">
      <div className="section-head">
        <h2>Следы</h2>
        <p className="section-sub">
          Сохранённые источники: откуда это взялось и где искать оригинал.
        </p>
      </div>

      <div className="traces-filters" role="tablist" aria-label="Вид следов">
        {FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            role="tab"
            aria-selected={kind === filter.id}
            className={'traces-filter' + (kind === filter.id ? ' is-active' : '')}
            onClick={() => setKind(filter.id)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {notice && (
        <div className="traces-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="icon-btn" onClick={() => setNotice('')} aria-label="Скрыть">✕</button>
        </div>
      )}

      {loading && <div className="roster-empty">Загрузка…</div>}

      {!loading && items.length === 0 && (
        <div className="roster-empty traces-empty">
          {kind === 'all'
            ? 'Пока пусто. «Наследить» в меню сообщения сохраняет не копию, а путь к источнику.'
            : 'В этом разрезе следов нет.'}
        </div>
      )}

      <div className="traces-list">
        {items.map((item) => {
          const broken = item.state !== 'ok';
          const copy = STATE_COPY[item.state];
          return (
            <div
              key={item.origin_message_id}
              className={'traces-row' + (broken ? ' is-broken' : '')}
            >
              <div className="traces-row-main">
                {item.state === 'ok' ? (
                  <>
                    <div className="traces-row-head">
                      <Avatar
                        name={item.chat?.name || ''}
                        avatarPath={item.chat?.avatar_path}
                        isGeneral={item.chat?.kind === 'general'}
                        isGroup={item.chat?.kind === 'group'}
                        isSelf={item.chat?.kind === 'self'}
                        size="sm"
                      />
                      <span className="traces-row-chat">{item.chat?.name}</span>
                      <span className="traces-row-author">{item.author}</span>
                      {!!item.message_created_at && (
                        <span className="traces-row-time">{formatChatListTime(item.message_created_at)}</span>
                      )}
                    </div>
                    <div className="traces-row-text">{preview(item)}</div>
                  </>
                ) : (
                  <div className="traces-row-broken">
                    <strong>{copy?.title}</strong>
                    <span>
                      {copy?.hint}
                      {item.state === 'cleaned' && item.deleted_by_name
                        ? ` ${item.deleted_by_name} подчистил этот след.`
                        : ''}
                    </span>
                  </div>
                )}

                {!!item.note && <div className="traces-row-note">{item.note}</div>}
              </div>

              <div className="traces-row-actions">
                {item.state === 'ok' && (
                  <button type="button" className="trace-action" onClick={() => openOrigin(item)}>
                    Найти след
                  </button>
                )}
                <button
                  type="button"
                  className="trace-action"
                  onClick={() => { setNoteFor(item); setNoteDraft(item.note || ''); }}
                >
                  {item.note ? 'Заметка' : 'Добавить заметку'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Окно — через общий примитив, иначе оно не попадёт ни в «Назад», ни в
          Escape, ни в режим клавиатуры Android. */}
      {noteFor && (
        <Modal onClose={() => setNoteFor(null)} className="trace-note-modal" persistent pageOnMobile>
          <ModalHead
            title="Заметка к следу"
            subtitle="Видите только вы"
            onClose={() => setNoteFor(null)}
          />
          <form onSubmit={submitNote} className="trace-note-form">
            <textarea
              value={noteDraft}
              maxLength={500}
              rows={4}
              placeholder="Зачем сохранили и к чему вернуться"
              onChange={(e) => setNoteDraft(e.target.value)}
              autoFocus={AUTOFOCUS_ON_OPEN}
            />
            <div className="trace-note-actions">
              <button type="button" className="trace-action" onClick={() => setNoteFor(null)}>Отмена</button>
              <button type="submit" className="btn-primary">Сохранить</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};

export default TracesSection;
