import React, { useEffect, useState } from 'react';
import superAdminApi from '@/shared/api/superAdminClient';
import { formatMoscowDateTime, fromMoscowInputValue, toMoscowInputValue } from '@/shared/lib/time';
import { UserRow } from '../types';

interface GoogleStatus {
  client_id: string;
  redirect_uri: string;
  has_secret: boolean;
  configured: boolean;
  scopes: string[];
  connected: boolean;
  email: string | null;
  calendar_id: string | null;
  calendar_name: string | null;
  owner_user_id: number | null;
  sync_from: number | null;
  last_sync_at: number | null;
  last_error: string | null;
  linked_count: number;
  readonly_count: number;
  sources: GoogleSource[];
}

interface GoogleCalendarOption {
  id: string;
  name: string;
  primary: boolean;
  access_role: string;
  writable: boolean;
}

/** Подключённый календарь: основной либо дополнительный, показываемый слоем. */
interface GoogleSource {
  id: number;
  google_calendar_id: string;
  name: string | null;
  color: string;
  access_role: string | null;
  read_only: number;
  is_main: number;
  last_error: string | null;
  linked_count: number;
}

// Та же палитра, что у событий календаря: цвет слоя выбирается из неё, чтобы
// дополнительный календарь отличался в сетке от общего и от личного.
const LAYER_COLORS: { value: string; label: string }[] = [
  { value: 'violet', label: 'Фиолетовый' },
  { value: 'teal', label: 'Бирюзовый' },
  { value: 'green', label: 'Зелёный' },
  { value: 'orange', label: 'Оранжевый' },
  { value: 'graphite', label: 'Графитовый' },
];

/**
 * Подключение гугл-аккаунта организации и настройки синхронизации.
 *
 * Аккаунт один на всех и синхронизируется с ОБЩИМ календарём: личные события
 * сотрудников в чужой гугл-аккаунт не уезжают. Подключение живёт в панели, а
 * не в профиле человека, именно поэтому — это настройка организации.
 */
export default function GoogleCalendarPanel({ users }: { users: UserRow[] }) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [calendars, setCalendars] = useState<GoogleCalendarOption[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [newSourceId, setNewSourceId] = useState('');
  const [newSourceColor, setNewSourceColor] = useState('violet');

  const load = async () => {
    try {
      const { data } = await superAdminApi.get<GoogleStatus>('/calendar/google/admin/status');
      setStatus(data);
      setClientId(data.client_id);
      setRedirectUri(data.redirect_uri);
      setError('');
    } catch {
      setError('Не удалось загрузить настройки');
    }
  };

  useEffect(() => { load(); }, []);

  // Список календарей аккаунта нужен только после подключения и только один
  // раз: он ходит в Google, и дёргать его на каждый рендер панели незачем.
  useEffect(() => {
    if (!status?.connected) { setCalendars([]); return; }
    superAdminApi.get<GoogleCalendarOption[]>('/calendar/google/admin/calendars')
      .then(({ data }) => setCalendars(data))
      .catch((e) => setError(e.response?.data?.error || 'Не удалось получить список календарей'));
  }, [status?.connected, status?.email]);

  const saveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await superAdminApi.put('/calendar/google/admin/config', {
        client_id: clientId,
        // Пустое поле значит «не меняли»: секрет наружу не отдаётся и в форму
        // не подставляется, так что пустым оно выглядит и когда он задан.
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      });
      setClientSecret('');
      setNote('Сохранено');
      setError('');
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setError('');
    try {
      const { data } = await superAdminApi.get<{ url: string }>('/calendar/google/admin/auth-url');
      // Отдельным окном, а не переходом: панель — это несохранённая форма и
      // открытые вкладки, и уводить её на сторону Google ради одного согласия
      // значило бы вернуться на пустое место.
      const popup = window.open(data.url, 'google-oauth', 'width=520,height=680');
      if (!popup) {
        setError('Браузер заблокировал окно — разрешите всплывающие окна для этого адреса');
        return;
      }
      // Окно на чужом домене, и достучаться до него нельзя — единственный
      // доступный признак завершения — что его закрыли.
      const timer = window.setInterval(() => {
        if (!popup.closed) return;
        window.clearInterval(timer);
        load();
      }, 800);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось начать подключение');
    }
  };

  const saveSettings = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await superAdminApi.put('/calendar/google/admin/settings', patch);
      setNote('Сохранено');
      setError('');
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const addSource = async () => {
    if (!newSourceId) return;
    const picked = calendars.find((c) => c.id === newSourceId);
    setBusy(true);
    try {
      await superAdminApi.post('/calendar/google/admin/sources', {
        calendar_id: newSourceId,
        name: picked?.name || newSourceId,
        color: newSourceColor,
      });
      setNewSourceId('');
      setNote('Календарь подключён. События приедут ближайшим обменом.');
      setError('');
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось подключить календарь');
    } finally {
      setBusy(false);
    }
  };

  const removeSource = async (source: GoogleSource) => {
    if (!window.confirm(
      `Отключить «${source.name || source.google_calendar_id}»? Его события удалятся из календаря чата — `
      + 'они были зеркалом и без источника обновлять их нечем. В самом Google ничего не изменится.'
    )) return;
    setBusy(true);
    try {
      const { data } = await superAdminApi.delete(`/calendar/google/admin/sources/${source.id}`);
      setNote(`Календарь отключён, событий убрано: ${data.removed_events}`);
      setError('');
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось отключить календарь');
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    setNote('');
    try {
      const { data } = await superAdminApi.post('/calendar/google/admin/sync');
      setNote(data.skipped
        ? data.reason
        : `Отправлено: ${data.pushed}, удалено: ${data.deleted}, получено: ${data.pulled}`);
      setError('');
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Синхронизация не прошла');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm(
      'Отключить аккаунт? Уже импортированные события останутся в общем календаре, '
      + 'но обмен изменениями прекратится.'
    )) return;
    setBusy(true);
    try {
      await superAdminApi.delete('/calendar/google/admin/connection');
      setNote('Аккаунт отключён');
      setError('');
      await load();
    } catch {
      setError('Не удалось отключить');
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <div className="sa-card sa-card--compact"><p className="sa-hint">Загрузка…</p></div>;

  return (
    <div className="sa-google">
      {error && <p className="form-error">{error}</p>}
      {note && <p className="sa-hint">{note}</p>}

      <div className="sa-card sa-card--compact">
        <h2>Приложение Google</h2>
        <p className="sa-hint">
          В <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">консоли
          Google Cloud</a> включите Google Calendar API, создайте учётные данные OAuth типа
          «Web application» и впишите адрес возврата в её «Authorized redirect URIs» —
          дословно, как здесь.
        </p>

        <form onSubmit={saveConfig} className="sa-google-form">
          <label>
            <span>client_id</span>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="…apps.googleusercontent.com"
            />
          </label>
          <label>
            <span>client_secret {status.has_secret && <em>— задан</em>}</span>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={status.has_secret ? 'оставьте пустым, чтобы не менять' : ''}
              autoComplete="new-password"
            />
          </label>
          <label>
            <span>Адрес возврата</span>
            <input
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
              placeholder="https://ваш-домен/miraschat/api/calendar/google/callback"
            />
          </label>
          <div className="sa-google-actions">
            <button type="submit" className="btn-primary" disabled={busy}>Сохранить</button>
          </div>
        </form>

        <p className="sa-hint">
          Запрашиваемые разрешения: календарь и адрес аккаунта. Ни почта, ни файлы не
          запрашиваются — это видно и в самом окне согласия.
        </p>
      </div>

      <div className="sa-card sa-card--compact">
        <h2>Аккаунт</h2>
        {status.connected ? (
          <>
            <p className="sa-hint">Подключён: <strong>{status.email || 'адрес неизвестен'}</strong></p>
            <div className="sa-google-actions">
              <button type="button" className="sa-btn-ghost" onClick={connect} disabled={busy}>
                Переподключить
              </button>
              <button type="button" className="sa-btn-danger" onClick={disconnect} disabled={busy}>
                Отключить
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="sa-hint">
              {status.configured
                ? 'Откроется окно согласия Google. Входить нужно в тот аккаунт, чей календарь синхронизируем.'
                : 'Сначала заполните client_id, секрет и адрес возврата выше.'}
            </p>
            <button type="button" className="btn-primary" onClick={connect} disabled={!status.configured || busy}>
              Подключить Google
            </button>
          </>
        )}
      </div>

      {status.connected && (
        <div className="sa-card sa-card--compact">
          <h2>Что синхронизируем</h2>

          <label className="sa-google-field">
            <span>Календарь</span>
            <select
              value={status.calendar_id || ''}
              onChange={(e) => {
                const picked = calendars.find((c) => c.id === e.target.value);
                saveSettings({ calendar_id: e.target.value || null, calendar_name: picked?.name || null });
              }}
              disabled={busy || !calendars.length}
            >
              <option value="">— не выбран —</option>
              {calendars.filter((c) => c.writable).map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.primary ? ' (основной)' : ''}</option>
              ))}
            </select>
          </label>
          <p className="sa-hint">
            Сюда уезжают события, созданные в общем календаре чата, поэтому выбрать можно
            только календарь с правом записи. Его содержимое попадает в общий календарь,
            а не в отдельный слой. Смена сбрасывает связи и начинает обмен заново.
          </p>

          <label className="sa-google-field">
            <span>Автор импортированных событий</span>
            <select
              value={status.owner_user_id || ''}
              onChange={(e) => saveSettings({ owner_user_id: Number(e.target.value) || null })}
              disabled={busy}
            >
              <option value="">— не выбран —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.display_name || u.username}</option>
              ))}
            </select>
          </label>
          <p className="sa-hint">
            У события в нашем календаре обязан быть автор из числа сотрудников, а
            супер-админ панели — отдельная учётная запись, и её сюда не подставить.
            Правят общий календарь всё равно все администраторы, от выбора это не зависит.
          </p>

          <label className="sa-google-field">
            <span>Импортировать начиная с</span>
            <input
              type="datetime-local"
              value={status.sync_from ? toMoscowInputValue(status.sync_from) : ''}
              onChange={(e) => {
                const ms = fromMoscowInputValue(e.target.value);
                if (ms !== null) saveSettings({ sync_from: ms });
              }}
              disabled={busy}
            />
          </label>
          <p className="sa-hint">
            Всё, что в гугл-календаре раньше этого момента, не импортируется: в нём может
            лежать многолетний архив, которому в общем календаре не место.
          </p>
        </div>
      )}

      {status.connected && (
        <div className="sa-card sa-card--compact">
          <h2>Дополнительные календари</h2>
          <p className="sa-hint">
            Каждый показывается в календаре чата отдельным слоем со своим цветом — так же,
            как «Другие календари» в самом Google. Они только читаются: право записи для
            них не нужно, и события из чата в них не уезжают.
          </p>

          {status.sources.filter((s) => !s.is_main).length > 0 && (
            <ul className="sa-google-sources">
              {status.sources.filter((s) => !s.is_main).map((source) => (
                <li key={source.id}>
                  <span className={`sa-google-dot sa-google-dot--${source.color}`} />
                  <span className="sa-google-source-name">
                    {source.name || source.google_calendar_id}
                    <em>
                      {source.linked_count > 0
                        ? `событий: ${source.linked_count}`
                        : 'событий пока нет'}
                      {source.read_only ? '' : ', есть право записи'}
                    </em>
                    {source.last_error && <em className="form-error">{source.last_error}</em>}
                  </span>
                  <button
                    type="button"
                    className="sa-btn-danger"
                    onClick={() => removeSource(source)}
                    disabled={busy}
                  >
                    Отключить
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="sa-google-add">
            <select
              value={newSourceId}
              onChange={(e) => setNewSourceId(e.target.value)}
              disabled={busy || !calendars.length}
            >
              <option value="">— выберите календарь —</option>
              {calendars
                .filter((c) => c.id !== status.calendar_id)
                .filter((c) => !status.sources.some((s) => s.google_calendar_id === c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.writable ? '' : ' — только чтение'}
                  </option>
                ))}
            </select>
            <select
              value={newSourceColor}
              onChange={(e) => setNewSourceColor(e.target.value)}
              disabled={busy}
            >
              {LAYER_COLORS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn-primary"
              onClick={addSource}
              disabled={busy || !newSourceId}
            >
              Подключить
            </button>
          </div>
        </div>
      )}

      {status.connected && (
        <div className="sa-card sa-card--compact">
          <h2>Состояние</h2>
          <p className="sa-hint">
            {status.last_sync_at
              ? `Последний обмен: ${formatMoscowDateTime(status.last_sync_at)} по Москве.`
              : 'Обмена ещё не было.'}
            {' '}Связано событий: {status.linked_count}.
          </p>
          {status.readonly_count > 0 && (
            <p className="sa-hint">
              Из них {status.readonly_count} — только на чтение: у них правило повтора,
              которое наш календарь целиком не выражает (например, «второй вторник месяца»).
              Такие события мы показываем, но обратно в Google не отправляем, чтобы не
              переписать там настоящее правило нашим приближением.
            </p>
          )}
          {status.last_error && <p className="form-error">Последняя ошибка: {status.last_error}</p>}
          <div className="sa-google-actions">
            <button type="button" className="btn-primary" onClick={syncNow} disabled={busy}>
              Синхронизировать сейчас
            </button>
          </div>
          <p className="sa-hint">Сам по себе обмен идёт каждые пять минут.</p>
        </div>
      )}
    </div>
  );
}

// Базовые реакции выбираются из общей панели загруженных смайликов. В настройке
// хранится shortcode, а системный Unicode остаётся только запасным отображением.
