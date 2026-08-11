import React, { useEffect, useMemo, useState } from 'react';
import Avatar from './Avatar';
import { ChatSection } from './ChatList';
import { AUTOFOCUS_ON_OPEN } from '../utils/autoFocus';
import { acquireStandardKeyboardResizeMode } from '../utils/mobileKeyboard';
import { CustomEmojiMap, renderTextWithEmoji } from '../utils/customEmoji';

export interface ForwardTarget {
  id: string;
  name: string;
  section: ChatSection;
  avatarPath?: string | null;
  /** Куда писать нельзя (канал-объявление без прав) — в списке не показываем. */
  disabled?: boolean;
}

export interface ForwardPreviewItem {
  id: number;
  text: string;
  author: string;
  hasImage: boolean;
}

interface ForwardModalProps {
  /** Что именно пересылаем — показываем до отправки, а не после. */
  items: ForwardPreviewItem[];
  targets: ForwardTarget[];
  onClose: () => void;
  onConfirm: (chatId: string) => void;
  customEmoji?: CustomEmojiMap;
}

const ForwardModal: React.FC<ForwardModalProps> = ({ items, targets, onClose, onConfirm, customEmoji = {} }) => {
  const [query, setQuery] = useState('');

  // Окно с полем ввода поверх переписки. Под ним остаётся смонтированный
  // MessageInput, держащий Android в overlay-режиме (adjustNothing): WebView под
  // клавиатуру не сжимается, а `.modal-overlay` растянут на `inset: 0`, поэтому
  // центрированная карточка остаётся по центру ВСЕГО экрана и её низ уходит под
  // IME — а поиск «Куда переслать» тут как раз внизу. Тот же приём, что в
  // PollCreator: на время окна берём штатный adjustResize.
  useEffect(() => acquireStandardKeyboardResizeMode(), []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return targets
      .filter((t) => !t.disabled)
      .filter((t) => !needle || t.name.toLowerCase().includes(needle));
  }, [targets, query]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card directory-modal forward-modal" onClick={(e) => e.stopPropagation()}>
        <div className="conv-head">
          <div className="conv-title">
            <div className="settings-title">Переслать</div>
            <div className="status">{items.length} сообщ.</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Что уедет — видно до выбора чата: пересылка нескольких сообщений
            иначе превращается в лотерею, особенно после выделения пачкой. */}
        <div className="forward-preview">
          {items.map((item) => (
            <div key={item.id} className="forward-preview-item">
              <span className="forward-preview-author">{item.author}</span>
              <span className="forward-preview-text">
                {item.text
                  ? renderTextWithEmoji(item.text, customEmoji, `fw${item.id}`)
                  : (item.hasImage ? '📷 Фото' : '')}
              </span>
            </div>
          ))}
        </div>

        <div className="directory-search">
          <input
            type="text"
            placeholder="Куда переслать…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus={AUTOFOCUS_ON_OPEN}
          />
        </div>

        <div className="directory-list">
          {filtered.length === 0 && <div className="roster-empty">Ничего не найдено</div>}
          {filtered.map((target) => (
            <div
              key={target.id}
              className="row directory-row"
              role="button"
              tabIndex={0}
              onClick={() => onConfirm(target.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onConfirm(target.id); } }}
            >
              <Avatar
                name={target.name}
                avatarPath={target.avatarPath}
                isGeneral={target.section === 'general'}
                isGroup={target.section === 'group'}
                isSelf={target.section === 'self'}
              />
              <div className="row-body">
                <div className="row-name"><span>{target.name}</span></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ForwardModal;
