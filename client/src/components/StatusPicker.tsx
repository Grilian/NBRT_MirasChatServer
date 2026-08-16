import React, { useMemo, useState } from 'react';
import api from '../api/client';
import EmojiPicker from './EmojiPicker';
import {
  STATUS_PRESETS, STATUS_PRESET_ORDER, StatusPreset,
  describeStatus, statusExpiryOn,
} from '../utils/statusMeta';

interface StatusPickerProps {
  statusPreset: string | null;
  statusCustom: string | null;
  statusExpiresAt?: number | null;
  onStatusChanged: (preset: string | null, custom: string | null) => void;
  /** Выбор подтверждён кнопкой «Установить» — внешнее окно можно закрыть. */
  onDone?: () => void;
}

type ExpiryChoice = 'never' | '30m' | '1h' | '3h' | 'today' | 'tomorrow' | 'custom';

const EXPIRY_CHOICES: Array<{ value: ExpiryChoice; label: string }> = [
  { value: 'never', label: 'Без срока' },
  { value: '30m', label: '30 минут' },
  { value: '1h', label: '1 час' },
  { value: '3h', label: '3 часа' },
  { value: 'today', label: 'Сегодня' },
  { value: 'tomorrow', label: 'Завтра' },
  { value: 'custom', label: 'Другая дата…' },
];

/**
 * Компактный редактор статуса.
 *
 * Важное UX-правило: клик по шаблону только выбирает его. На сервер статус
 * отправляется исключительно по кнопке «Установить», чтобы пользователь мог
 * сначала подобрать шаблон и срок, не закрывая окно на первом клике.
 */
const StatusPicker: React.FC<StatusPickerProps> = ({
  statusPreset, statusCustom, statusExpiresAt = null, onStatusChanged, onDone,
}) => {
  const parsed = splitEmoji(statusCustom || '');
  const [emoji, setEmoji] = useState(parsed.emoji || '💬');
  const [customStatus, setCustomStatus] = useState(parsed.text);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [expiryChoice, setExpiryChoice] = useState<ExpiryChoice>('never');
  const [until, setUntil] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const initialPreset = (statusPreset && STATUS_PRESETS[statusPreset as StatusPreset])
    ? statusPreset as StatusPreset
    : null;
  const [selectedPreset, setSelectedPreset] = useState<StatusPreset | null>(initialPreset);

  const currentStatus = useMemo(
    () => describeStatus(statusPreset, statusCustom),
    [statusPreset, statusCustom],
  );

  const customSelected = !selectedPreset && !!customStatus.trim();

  const expiryPayload = (): number | null => {
    const now = Date.now();
    if (expiryChoice === '30m') return now + 30 * 60 * 1000;
    if (expiryChoice === '1h') return now + 60 * 60 * 1000;
    if (expiryChoice === '3h') return now + 3 * 60 * 60 * 1000;
    if (expiryChoice === 'today') return endOfDay(0);
    if (expiryChoice === 'tomorrow') return endOfDay(1);
    if (expiryChoice === 'custom') return until ? statusExpiryOn(until) : null;
    return null;
  };

  const saveStatus = async (preset: StatusPreset | null, custom: string | null) => {
    setSaving(true);
    setError('');
    try {
      const expiresAt = preset || custom ? expiryPayload() : null;
      if (expiryChoice === 'custom' && (preset || custom) && !expiresAt) {
        setError('Выберите будущую дату и время');
        return;
      }
      const { data } = await api.put('/users/me/status', {
        status_preset: preset,
        status_custom: custom,
        status_expires_at: expiresAt,
      });
      onStatusChanged(data.status_preset, data.status_custom);
      if (data.status_custom) {
        const next = splitEmoji(data.status_custom);
        setCustomStatus(next.text);
        if (next.emoji) setEmoji(next.emoji);
      }
      onDone?.();
    } catch {
      setError('Не удалось изменить статус');
    } finally {
      setSaving(false);
    }
  };

  const submitStatus = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = customStatus.trim();
    if (selectedPreset) {
      void saveStatus(selectedPreset, null);
      return;
    }
    if (trimmed) void saveStatus(null, `${emoji} ${trimmed}`.trim());
  };

  const hasStatus = !!(statusPreset || statusCustom);

  return (
    <div className="status-picker">
      <div className="status-picker-layout">
        <form className={'status-status-card' + (emojiOpen ? ' has-emoji-popover' : '')} onSubmit={submitStatus}>
          <div className="status-current-block">
            <span className="status-card-kicker">Текущий статус</span>
            <div className="status-current-value">
              <span className={'status-current-dot' + (currentStatus ? ' is-custom' : '')} />
              <span>{currentStatus ? `${currentStatus.emoji} ${currentStatus.label}` : 'Без статуса'}</span>
            </div>
          </div>

          <div className="status-list-title">Установить статус</div>
          <div className="status-preset-list">
            {STATUS_PRESET_ORDER.map((preset) => (
              <button
                key={preset}
                type="button"
                className={'status-preset-row' + (selectedPreset === preset ? ' is-active' : '')}
                disabled={saving}
                onClick={() => {
                  setSelectedPreset(preset);
                  setCustomStatus('');
                  setEmojiOpen(false);
                }}
              >
                <span className="status-preset-row-icon">{STATUS_PRESETS[preset].emoji}</span>
                <span>{STATUS_PRESETS[preset].label}</span>
                <span className="status-preset-check" aria-hidden="true">✓</span>
              </button>
            ))}

            <div className={'status-custom-row' + (customSelected ? ' is-active' : '')}>
              <button
                type="button"
                className="status-custom-emoji"
                title="Выбрать эмодзи"
                aria-label="Выбрать эмодзи"
                onClick={() => {
                  setSelectedPreset(null);
                  setEmojiOpen((open) => !open);
                }}
              >
                {emoji}
              </button>
              <input
                type="text"
                placeholder="Свой статус…"
                value={customStatus}
                maxLength={58}
                onFocus={() => setSelectedPreset(null)}
                onChange={(event) => {
                  setCustomStatus(event.target.value);
                  setSelectedPreset(null);
                }}
              />
              {customSelected && <span className="status-preset-check" aria-hidden="true">✓</span>}
            </div>
          </div>

          {emojiOpen && (
            <div className="status-emoji-popover">
              <EmojiPicker
                embedded
                onPick={(picked) => {
                  setEmoji(typeof picked === 'string' ? picked : (picked.fallback || '💬'));
                  setSelectedPreset(null);
                  setEmojiOpen(false);
                }}
                onClose={() => setEmojiOpen(false)}
              />
            </div>
          )}

          {error && <div className="status-error" role="status">{error}</div>}

          <button
            type="submit"
            className="btn-primary status-install-button"
            disabled={saving || (!selectedPreset && !customStatus.trim())}
          >
            {saving ? 'Сохраняем…' : 'Установить'}
          </button>

          {hasStatus && (
            <button
              type="button"
              className="status-remove-button"
              disabled={saving}
              onClick={() => void saveStatus(null, null)}
            >
              Снять статус
            </button>
          )}
        </form>

        <section className="status-expiry-card">
          <span className="status-card-kicker">Выбор срока</span>
          <div className="status-expiry-title">Снять через</div>
          <div className="status-expiry-options" role="radiogroup" aria-label="Когда снять статус">
            {EXPIRY_CHOICES.map((choice) => (
              <label key={choice.value} className={'status-expiry-option' + (expiryChoice === choice.value ? ' is-active' : '')}>
                <input
                  type="radio"
                  name="status-expiry"
                  value={choice.value}
                  checked={expiryChoice === choice.value}
                  disabled={saving}
                  onChange={() => {
                    setExpiryChoice(choice.value);
                    if (choice.value !== 'custom') setUntil('');
                  }}
                />
                <span className="status-radio-mark" />
                <span>{choice.label}</span>
              </label>
            ))}
          </div>

          {expiryChoice !== 'never' && expiryChoice !== 'custom' && (
            <div className="status-expiry-inline-hint">{describeChoiceHint(expiryChoice)}</div>
          )}

          {expiryChoice === 'custom' && (
            <div className="status-custom-date">
              <input
                type="datetime-local"
                value={until}
                min={minDateTime()}
                onChange={(event) => setUntil(event.target.value)}
                disabled={saving}
                aria-label="Дата снятия статуса"
              />
              {until && <div className="status-expiry-hint">{describeUntil(until)}</div>}
            </div>
          )}

          {statusExpiresAt && hasStatus && (
            <div className="status-existing-expiry">
              Текущий статус снимется {new Date(statusExpiresAt).toLocaleString('ru-RU', {
                day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

/** Первый графемный кластер своего статуса считаем эмодзи, если он pictographic. */
function splitEmoji(value: string): { emoji: string; text: string } {
  const trimmed = value.trim();
  if (!trimmed) return { emoji: '', text: '' };

  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const Segmenter = (Intl as any).Segmenter;
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
    const first = Array.from(segmenter.segment(trimmed) as Iterable<{ segment: string }>)[0]?.segment || '';
    if (first && /\p{Extended_Pictographic}/u.test(first)) {
      return { emoji: first, text: trimmed.slice(first.length).trim() };
    }
  }

  const first = Array.from(trimmed)[0];
  if (first && /\p{Extended_Pictographic}/u.test(first)) {
    return { emoji: first, text: trimmed.slice(first.length).trim() };
  }
  return { emoji: '', text: trimmed };
}

function endOfDay(dayOffset: number): number {
  const target = new Date();
  target.setDate(target.getDate() + dayOffset);
  target.setHours(23, 59, 59, 999);
  return target.getTime();
}

function describeChoiceHint(choice: ExpiryChoice): string {
  if (choice === '30m') return 'Статус снимется через 30 минут от текущего момента';
  if (choice === '1h') return 'Статус снимется через 1 час от текущего момента';
  if (choice === '3h') return 'Статус снимется через 3 часа от текущего момента';
  if (choice === 'today') return 'Статус будет снят сегодня в 23:59';
  if (choice === 'tomorrow') return 'Статус будет снят завтра в 23:59';
  return '';
}

function describeUntil(value: string): string {
  const target = statusExpiryOn(value);
  if (!target) return 'Этот момент уже прошёл — выберите другой';
  return `Снимется ${new Date(target).toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  })}`;
}

function minDateTime(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

export default StatusPicker;
