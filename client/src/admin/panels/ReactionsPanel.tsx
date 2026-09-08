import React, { useEffect, useRef, useState } from 'react';
import superAdminApi from '@/shared/api/superAdminClient';
import EmojiPicker, { EmojiPack as PickerEmojiPack } from '@/features/emoji/EmojiPicker';
import { CustomEmojiImage, DEFAULT_EMOJI_FALLBACK } from '@/features/emoji/customEmoji';
import { dismissLayerWithoutUnderlayActivation } from '@/shared/hooks/dismissLayer';
import { EmojiCustomItem, EmojiPack } from '../emojiTypes';

export default function ReactionsPanel() {
  const [selected, setSelected] = useState<string[]>([]);
  const [packs, setPacks] = useState<EmojiPack[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const closeOutside = (event: Event) => {
      if (pickerRef.current?.contains(event.target as Node)) return;
      dismissLayerWithoutUnderlayActivation(event, () => setPickerOpen(false));
    };
    window.addEventListener('pointerdown', closeOutside, true);
    window.addEventListener('mousedown', closeOutside, true);
    window.addEventListener('touchstart', closeOutside, { capture: true, passive: false });
    return () => {
      window.removeEventListener('pointerdown', closeOutside, true);
      window.removeEventListener('mousedown', closeOutside, true);
      window.removeEventListener('touchstart', closeOutside, true);
    };
  }, [pickerOpen]);

  const load = async () => {
    try {
      const [reactionsResponse, emojiResponse] = await Promise.all([
        superAdminApi.get('/superadmin/reactions'),
        superAdminApi.get('/emoji/admin'),
      ]);
      setSelected(reactionsResponse.data.emoji || []);
      setPacks(emojiResponse.data.packs || emojiResponse.data || []);
      setError('');
    } catch {
      setError('Не удалось загрузить реакции');
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const { data } = await superAdminApi.put('/superadmin/reactions', { emoji: selected });
      setSelected(data.emoji || []);
      setError('');
      setStatus('Сохранено');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось сохранить');
    }
  };

  const pickerPacks: PickerEmojiPack[] = packs
    .filter((pack) => pack.enabled && (pack.custom || []).length > 0)
    .map((pack) => ({
      id: pack.id,
      name: pack.name,
      emoji: [],
      custom: pack.custom || [],
    }));

  const itemsByToken = new Map<string, EmojiCustomItem>();
  for (const pack of packs) {
    for (const item of pack.custom || []) {
      itemsByToken.set(`:${item.name}:`, item);
      if (item.unicode_key && item.unicode) itemsByToken.set(item.unicode, item);
    }
  }

  const toggle = (token: string) => {
    setStatus('');
    setSelected((current) => current.includes(token)
      ? current.filter((item) => item !== token)
      : [...current, token]);
  };

  return (
    <div className="sa-card sa-card--compact">
      <h2>Реакции</h2>
      {error && <p className="form-error">{error}</p>}

      <p className="sa-hint">
        Выберите загруженные смайлики, которые человек увидит над меню сообщения.
        Количество не ограничено. Уже поставленные реакции останутся, даже если
        убрать смайлик из этого списка.
      </p>

      <div className="sa-reaction-preview" aria-label="Выбранные реакции">
        {selected.length === 0 && <span className="sa-hint">Реакции пока не выбраны</span>}
        {selected.map((token) => {
          const item = itemsByToken.get(token);
          return (
            <button key={token} type="button" onClick={() => toggle(token)} title="Убрать реакцию">
              {item
                ? <CustomEmojiImage filePath={item.file_path} fallback={item.fallback || DEFAULT_EMOJI_FALLBACK} />
                : token}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="sa-reaction-picker-toggle"
        onClick={() => setPickerOpen((open) => !open)}
      >
        {pickerOpen ? 'Закрыть смайлики' : 'Выбрать смайлики'}
      </button>

      {pickerOpen && (
        <div className="sa-reaction-picker" ref={pickerRef}>
          <EmojiPicker
            embedded
            packsOverride={pickerPacks}
            selectedCustomEmoji={selected}
            onClose={() => setPickerOpen(false)}
            onPick={(picked) => {
              if (typeof picked !== 'string') toggle(picked.token || `:${picked.name}:`);
            }}
          />
        </div>
      )}

      <form onSubmit={save} className="sa-reaction-save">
        <span className="sa-hint">Выбрано: {selected.length}</span>
        <button type="submit" className="btn-primary">Сохранить</button>
      </form>

      {status && <p className="sa-hint">{status}</p>}
    </div>
  );
}

// Личный чат «для себя» — заметки и пересылки. Настраивать тут пока нечего,
// кроме названия: сам чат существует у каждого по определению (chat_id вида
// self_<id>), заводить и удалять его нельзя.
