import React, { useState } from 'react';
import api from '../api/client';
import {
  STATUS_DURATION_OPTIONS, STATUS_PRESETS, STATUS_PRESET_ORDER, StatusPreset, statusExpiryFrom,
} from '../utils/statusMeta';

interface StatusPickerProps {
  statusPreset: string | null;
  statusCustom: string | null;
  onStatusChanged: (preset: string | null, custom: string | null) => void;
  /** Выбор сделан — окну поверх (StatusSheet) пора закрыться. */
  onDone?: () => void;
}

/**
 * Выбор статуса: пресеты, свой текст и срок, через который статус снимется.
 *
 * Живёт отдельным компонентом, потому что мест, откуда статус ставят, стало
 * два — профиль и лист по тапу на свой аватар. Запрос сохранения тоже внутри:
 * вынеси его наружу — и каждое место повторяло бы и вызов, и обработку
 * ошибки, а значит рано или поздно повело бы себя по-разному.
 */
const StatusPicker: React.FC<StatusPickerProps> = ({
  statusPreset, statusCustom, onStatusChanged, onDone,
}) => {
  const [customStatus, setCustomStatus] = useState(statusCustom || '');
  const [statusDuration, setStatusDuration] = useState<number | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);

  const saveStatus = async (preset: StatusPreset | null, custom: string | null) => {
    setStatusSaving(true);
    try {
      const { data } = await api.put('/users/me/status', {
        status_preset: preset,
        status_custom: custom,
        // Снятие статуса срока не несёт — сервер обнулит его сам.
        status_expires_at: preset || custom ? statusExpiryFrom(statusDuration) : null,
      });
      onStatusChanged(data.status_preset, data.status_custom);
      if (data.status_custom) setCustomStatus(data.status_custom);
      onDone?.();
    } catch {
      // Молчим: статус — необязательная мелочь, ронять UI ради неё незачем.
    } finally {
      setStatusSaving(false);
    }
  };

  const togglePreset = (preset: StatusPreset) => {
    saveStatus(statusPreset === preset ? null : preset, null);
  };

  const submitCustomStatus = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = customStatus.trim();
    if (trimmed) saveStatus(null, trimmed);
  };

  return (
    <div className="settings-group">
      <div className="status-presets">
        {STATUS_PRESET_ORDER.map((preset) => (
          <button
            key={preset}
            type="button"
            className={'status-preset-btn' + (statusPreset === preset ? ' is-active' : '')}
            disabled={statusSaving}
            onClick={() => togglePreset(preset)}
          >
            <span>{STATUS_PRESETS[preset].emoji}</span> {STATUS_PRESETS[preset].label}
          </button>
        ))}
      </div>

      <form className="status-custom-form" onSubmit={submitCustomStatus}>
        <input
          type="text"
          placeholder="Свой статус…"
          value={customStatus}
          onChange={(e) => setCustomStatus(e.target.value)}
          maxLength={60}
        />
        <button type="submit" className="sa-btn-ghost" disabled={statusSaving || !customStatus.trim()}>Ок</button>
        {(statusPreset || statusCustom) && (
          <button type="button" className="sa-btn-ghost" disabled={statusSaving} onClick={() => saveStatus(null, null)}>
            Убрать
          </button>
        )}
      </form>

      <div className="status-duration">
        <label htmlFor="status-duration">Снять через</label>
        <select
          id="status-duration"
          value={statusDuration === null ? '' : String(statusDuration)}
          onChange={(e) => setStatusDuration(e.target.value ? Number(e.target.value) : null)}
          disabled={statusSaving}
        >
          {STATUS_DURATION_OPTIONS.map((option) => (
            <option key={option.label} value={option.value === null ? '' : String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};

export default StatusPicker;
