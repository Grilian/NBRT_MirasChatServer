import React, { useEffect, useRef, useState } from 'react';
import superAdminApi from '@/shared/api/superAdminClient';
import EmojiPicker, { EmojiPack as PickerEmojiPack } from '@/features/emoji/EmojiPicker';
import { CustomEmojiImage, DEFAULT_EMOJI_FALLBACK } from '@/features/emoji/customEmoji';
import { dismissLayerWithoutUnderlayActivation } from '@/shared/hooks/dismissLayer';
import { EmojiCustomItem, EmojiPack } from '../emojiTypes';

export default function SelfChatPanel() {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = async () => {
    try {
      const { data } = await superAdminApi.get('/superadmin/self-chat');
      setName(data.name);
      setSaved(data.name);
    } catch {
      setError('Не удалось загрузить название');
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const { data } = await superAdminApi.put('/superadmin/self-chat', { name });
      setName(data.name);
      setSaved(data.name);
      setError('');
      setStatus('Сохранено');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось сохранить');
    }
  };

  return (
    <div className="sa-card sa-card--compact">
      <h2>Следы / Избранное / Облако</h2>
      {error && <p className="form-error">{error}</p>}

      <p className="sa-hint">
        Это одна и та же сущность — личный чат, куда человек складывает заметки и
        пересылает сообщения. Видит его только владелец. Название общее для всех:
        сейчас — «{saved}».
      </p>

      <form onSubmit={save} className="sa-inline-form">
        <input
          type="text"
          value={name}
          maxLength={40}
          placeholder="Следы"
          onChange={(e) => { setName(e.target.value); setStatus(''); }}
        />
        <button type="submit" className="btn-primary">Сохранить</button>
      </form>

      {status && <p className="sa-hint">{status}</p>}
    </div>
  );
}
