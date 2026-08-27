import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/client';
import EmojiPicker from './EmojiPicker';
import {
  CustomEmojiMap, preferCustomEmojiToken, renderTextWithEmoji,
} from '../utils/customEmoji';
import {
  STATUS_PRESETS, STATUS_PRESET_ORDER, StatusPreset,
  describeStatus, splitStatusIcon, statusExpiryOn,
} from '../utils/statusMeta';
import { dismissLayerWithoutUnderlayActivation } from '../utils/dismissLayer';

interface StatusPickerProps {
  statusPreset: string | null;
  statusCustom: string | null;
  statusExpiresAt?: number | null;
  onStatusChanged: (preset: string | null, custom: string | null) => void;
  /** Каталог нужен и для выбранного изображения, и для fallback-отрисовки. */
  customEmoji?: CustomEmojiMap;
  /** Выбор подтверждён кнопкой «Установить» — внешнее окно можно закрыть. */
  onDone?: () => void;
}

type ExpiryChoice = 'never' | '30m' | '1h' | '3h' | 'today' | 'tomorrow' | 'custom';
const MAX_STATUS_LENGTH = 60;

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
  customEmoji = {},
}) => {
  const parsed = splitStatusIcon(statusCustom || '');
  const [emoji, setEmoji] = useState(parsed.emoji || preferCustomEmojiToken('💬', customEmoji));
  const [customStatus, setCustomStatus] = useState(parsed.text);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [expiryChoice, setExpiryChoice] = useState<ExpiryChoice>('never');
  const [until, setUntil] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const emojiPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!emojiOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEmojiOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [emojiOpen]);

  // Тап снаружи на мобильном тоже закрывает панель — тем же общим helper'ом,
  // что и остальные всплывающие поверхности, чтобы жест не долетал до того,
  // что находится под попапом.
  useEffect(() => {
    if (!emojiOpen) return undefined;
    const closeOutside = (event: Event) => {
      if (emojiPopoverRef.current?.contains(event.target as Node)) return;
      dismissLayerWithoutUnderlayActivation(event, () => setEmojiOpen(false));
    };
    window.addEventListener('pointerdown', closeOutside, true);
    window.addEventListener('mousedown', closeOutside, true);
    window.addEventListener('touchstart', closeOutside, { capture: true, passive: false });
    return () => {
      window.removeEventListener('pointerdown', closeOutside, true);
      window.removeEventListener('mousedown', closeOutside, true);
      window.removeEventListener('touchstart', closeOutside, true);
    };
  }, [emojiOpen]);

  const initialPreset = (statusPreset && STATUS_PRESETS[statusPreset as StatusPreset])
    ? statusPreset as StatusPreset
    : null;
  const [selectedPreset, setSelectedPreset] = useState<StatusPreset | null>(initialPreset);

  const currentStatus = useMemo(
    () => describeStatus(statusPreset, statusCustom, customEmoji),
    [statusPreset, statusCustom, customEmoji],
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
        const next = splitStatusIcon(data.status_custom);
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
              <span>{currentStatus
                ? renderTextWithEmoji(`${currentStatus.emoji} ${currentStatus.label}`, customEmoji, 'status-current')
                : 'Без статуса'}</span>
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
                <span className="status-preset-row-icon">
                  {renderTextWithEmoji(
                    preferCustomEmojiToken(STATUS_PRESETS[preset].emoji, customEmoji),
                    customEmoji,
                    `status-preset-${preset}`,
                  )}
                </span>
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
                {renderTextWithEmoji(emoji, customEmoji, 'status-selected')}
              </button>
              <input
                type="text"
                placeholder="Свой статус…"
                value={customStatus}
                maxLength={Math.max(1, MAX_STATUS_LENGTH - emoji.length - 1)}
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
            <div className="status-emoji-popover" ref={emojiPopoverRef}>
              <button
                type="button"
                className="status-emoji-popover-close"
                onClick={() => setEmojiOpen(false)}
                aria-label="Закрыть панель смайликов"
                title="Закрыть"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
              <EmojiPicker
                embedded
                onPick={(picked) => {
                  // Для загруженного смайлика сохраняем стабильный shortcode,
                  // а не fallback: иначе любой выбор превращался в одну и ту
                  // же системную улыбку и терял связь со своим изображением.
                  const nextEmoji = typeof picked === 'string' ? picked : `:${picked.name}:`;
                  setEmoji(nextEmoji);
                  // Сервер принимает статус целиком длиной до 60 символов.
                  // Shortcode длиннее одного Unicode-графема, поэтому при
                  // смене значка уже набранную подпись подрезаем до честного
                  // лимита, а не отправляем заведомо невалидный запрос.
                  setCustomStatus((value) => value.slice(
                    0,
                    Math.max(1, MAX_STATUS_LENGTH - nextEmoji.length - 1),
                  ));
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
