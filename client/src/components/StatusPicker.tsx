import React, { useState } from 'react';
import api from '../api/client';
import EmojiPicker from './EmojiPicker';
import {
  STATUS_DURATION_OPTIONS, STATUS_PRESETS, STATUS_PRESET_ORDER, StatusPreset,
  statusExpiryAt, statusExpiryFrom,
} from '../utils/statusMeta';

interface StatusPickerProps {
  statusPreset: string | null;
  statusCustom: string | null;
  statusExpiresAt?: number | null;
  onStatusChanged: (preset: string | null, custom: string | null) => void;
  /** Выбор сделан — окну поверх (StatusSheet) пора закрыться. */
  onDone?: () => void;
}

/**
 * Выбор статуса: пресеты, свой текст со своим эмодзи и срок снятия.
 *
 * Живёт отдельным компонентом, потому что мест, откуда статус ставят, два —
 * профиль и лист по тапу на свой статус. Запрос сохранения тоже внутри: вынеси
 * его наружу — и каждое место повторяло бы и вызов, и обработку ошибки, а
 * значит рано или поздно повело бы себя по-разному.
 *
 * Эмодзи своего статуса хранится ПЕРВЫМ СИМВОЛОМ самого текста, а не отдельной
 * колонкой: статус показывается в десятке мест (список чатов, шапка, профиль,
 * поле ввода собеседника), и новое поле пришлось бы протаскивать в каждое.
 * Разбирает его обратно `describeStatus` — там же, где решает, что показать.
 */
const StatusPicker: React.FC<StatusPickerProps> = ({
  statusPreset, statusCustom, statusExpiresAt = null, onStatusChanged, onDone,
}) => {
  // Текст и эмодзи разбираем из сохранённого статуса: если он был поставлен с
  // эмодзи, окно должно открыться в том же виде, а не терять его.
  const parsed = splitEmoji(statusCustom || '');
  const [emoji, setEmoji] = useState(parsed.emoji || '💬');
  const [customStatus, setCustomStatus] = useState(parsed.text);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [untilTime, setUntilTime] = useState('');
  const [saving, setSaving] = useState(false);

  const expiryPayload = () => {
    // Конкретное время побеждает длительность: человек указал его последним и
    // явно — это точнее, чем «через сколько-то».
    if (untilTime) return statusExpiryAt(untilTime);
    return statusExpiryFrom(duration);
  };

  const saveStatus = async (preset: StatusPreset | null, custom: string | null) => {
    setSaving(true);
    try {
      const { data } = await api.put('/users/me/status', {
        status_preset: preset,
        status_custom: custom,
        // Снятие статуса срока не несёт — сервер обнулит его сам.
        status_expires_at: preset || custom ? expiryPayload() : null,
      });
      onStatusChanged(data.status_preset, data.status_custom);
      if (data.status_custom) {
        const next = splitEmoji(data.status_custom);
        setCustomStatus(next.text);
        if (next.emoji) setEmoji(next.emoji);
      }
      onDone?.();
    } catch {
      // Молчим: статус — необязательная мелочь, ронять UI ради неё незачем.
    } finally {
      setSaving(false);
    }
  };

  const submitCustomStatus = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = customStatus.trim();
    if (trimmed) saveStatus(null, `${emoji} ${trimmed}`.trim());
  };

  const hasStatus = !!(statusPreset || statusCustom);

  return (
    <div className="status-picker">
      <div className="status-presets">
        {STATUS_PRESET_ORDER.map((preset) => (
          <button
            key={preset}
            type="button"
            className={'status-preset-btn' + (statusPreset === preset ? ' is-active' : '')}
            disabled={saving}
            onClick={() => saveStatus(statusPreset === preset ? null : preset, null)}
          >
            <span className="status-preset-emoji">{STATUS_PRESETS[preset].emoji}</span>
            {STATUS_PRESETS[preset].label}
          </button>
        ))}
      </div>

      <form className="status-custom-form" onSubmit={submitCustomStatus}>
        <div className="status-custom-field">
          <button
            type="button"
            className="status-emoji-btn"
            title="Выбрать эмодзи"
            aria-label="Выбрать эмодзи"
            onClick={() => setEmojiOpen((open) => !open)}
          >
            {emoji}
          </button>
          <input
            type="text"
            placeholder="Свой статус…"
            value={customStatus}
            onChange={(e) => setCustomStatus(e.target.value)}
            maxLength={58}
          />
        </div>

        {emojiOpen && (
          <div className="status-emoji-popover">
            <EmojiPicker
              embedded
              onPick={(picked) => {
                // Картиночный смайлик в статусе показать нечем: статус живёт
                // текстом в десятке мест. Берём его базовый юникодный символ —
                // он для того и хранится.
                setEmoji(typeof picked === 'string' ? picked : (picked.fallback || '💬'));
                setEmojiOpen(false);
              }}
              onClose={() => setEmojiOpen(false)}
            />
          </div>
        )}

        <div className="status-expiry">
          <div className="status-expiry-row">
            <label htmlFor="status-duration">Снять</label>
            <select
              id="status-duration"
              value={duration === null ? '' : String(duration)}
              onChange={(e) => {
                setDuration(e.target.value ? Number(e.target.value) : null);
                // Выбрали длительность — конкретное время сбрасываем, иначе
                // непонятно, что из двух сработает.
                setUntilTime('');
              }}
              disabled={saving}
            >
              {STATUS_DURATION_OPTIONS.map((option) => (
                <option key={option.label} value={option.value === null ? '' : String(option.value)}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="status-expiry-row">
            <label htmlFor="status-until">до</label>
            <input
              id="status-until"
              type="time"
              value={untilTime}
              onChange={(e) => { setUntilTime(e.target.value); setDuration(null); }}
              disabled={saving}
            />
            {untilTime && (
              <button type="button" className="status-expiry-clear" onClick={() => setUntilTime('')}>
                сбросить
              </button>
            )}
          </div>
          {/* Прошедшее время значит «завтра»: «до 9:00», поставленное вечером,
              иначе сняло бы статус мгновенно. */}
          {untilTime && <p className="status-expiry-hint">{describeUntil(untilTime)}</p>}
          {!untilTime && statusExpiresAt && hasStatus && (
            <p className="status-expiry-hint">
              Сейчас снимется {new Date(statusExpiresAt).toLocaleString('ru-RU', {
                hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long',
              })}
            </p>
          )}
        </div>

        <div className="status-actions">
          <button type="submit" className="btn-primary" disabled={saving || !customStatus.trim()}>
            Установить
          </button>
          {hasStatus && (
            <button type="button" className="sa-btn-ghost" disabled={saving} onClick={() => saveStatus(null, null)}>
              Убрать статус
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

/** Первый символ статуса — эмодзи, если он там есть. */
function splitEmoji(value: string): { emoji: string; text: string } {
  const trimmed = value.trim();
  if (!trimmed) return { emoji: '', text: '' };
  // Разбираем по графемам: у эмодзи бывают модификаторы и ZWJ-склейки, и
  // посимвольная нарезка порвала бы «👩‍💻» на части.
  const first = Array.from(trimmed)[0];
  const isEmoji = /\p{Extended_Pictographic}/u.test(first);
  if (!isEmoji) return { emoji: '', text: trimmed };
  const rest = trimmed.slice(first.length).replace(/^[️‍\p{Extended_Pictographic}]+/u, '');
  return { emoji: trimmed.slice(0, trimmed.length - rest.length).trim(), text: rest.trim() };
}

function describeUntil(time: string): string {
  const target = statusExpiryAt(time);
  if (!target) return '';
  const sameDay = new Date(target).toDateString() === new Date().toDateString();
  return `Снимется ${sameDay ? 'сегодня' : 'завтра'} в ${time}`;
}

export default StatusPicker;
