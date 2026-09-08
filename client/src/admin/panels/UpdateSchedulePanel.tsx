import React, { useEffect, useState } from 'react';
import superAdminApi from '@/shared/api/superAdminClient';
import { formatMoscowDateTime, fromMoscowInputValue, toMoscowInputValue } from '@/shared/lib/time';

export default function UpdateSchedulePanel() {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = async () => {
    try {
      const { data } = await superAdminApi.get('/superadmin/update-schedule');
      setSaved(data.notBefore ?? null);
      setValue(data.notBefore ? toMoscowInputValue(data.notBefore) : '');
    } catch {
      setError('Не удалось загрузить расписание');
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const ms = fromMoscowInputValue(value);
    if (ms === null) {
      setError('Укажите дату и время');
      return;
    }
    try {
      const { data } = await superAdminApi.put('/superadmin/update-schedule', { notBefore: ms });
      setSaved(data.notBefore);
      setError('');
      setStatus('Сохранено');
    } catch {
      setError('Не удалось сохранить');
    }
  };

  const clear = async () => {
    try {
      await superAdminApi.put('/superadmin/update-schedule', { notBefore: null });
      setSaved(null);
      setValue('');
      setError('');
      setStatus('Обновления ставятся сразу');
    } catch {
      setError('Не удалось сохранить');
    }
  };

  return (
    <div className="sa-card sa-card--compact">
      <h2>Обновления</h2>
      {error && <p className="form-error">{error}</p>}

      <p className="sa-hint">
        {saved === null
          ? 'Время не задано — клиенты ставят новую версию сразу, как только она появится на сервере.'
          : `Ближайшая установка: ${formatMoscowDateTime(saved)} по Москве.`}
      </p>

      <p className="sa-hint">
        Время, назначенное раньше, чем залит билд, считается уже прошедшим — такая
        версия уедет клиентам сразу. Клиент, выключенный в назначенный час,
        обновится при следующем запуске.
      </p>

      <form onSubmit={save} className="sa-inline-form">
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => { setValue(e.target.value); setStatus(''); }}
        />
        <button type="submit" className="btn-primary">Сохранить</button>
        <button type="button" className="sa-btn-ghost" onClick={clear}>Ставить сразу</button>
      </form>

      {status && <p className="sa-hint">{status}</p>}
    </div>
  );
}

// Учётные записи с улицы. Их разбирают отдельно от сотрудников: подтвердить
// (сменить тип на «Сотрудник») или удалить. Метка New снимается со всех разом,
// когда админ уходит с вкладки — по условию «открыл и что-то сделал»: любое
// действие, включая переход на другую страницу, считается разбором.
