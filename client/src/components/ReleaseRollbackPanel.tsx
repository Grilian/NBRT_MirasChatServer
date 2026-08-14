import React, { useEffect, useState } from 'react';
import superAdminApi from '../api/superAdminClient';

// Откат к предыдущей версии.
//
// Что кнопка делает на самом деле: переписывает манифесты раздачи
// (`latest.yml`, `android.json`, `linux.json`) на более старую сборку, которая
// всё ещё лежит на сервере. Файлы сборок не удаляются — иначе вернуться было
// бы некуда, ни назад, ни вперёд.

interface Release {
  version: string;
  windows: string | null;
  android: string | null;
  deb: string | null;
  targz: string | null;
  androidVersionCode: number | null;
}

interface ReleasesState {
  available: boolean;
  dir: string;
  current: {
    windows: string | null;
    android: string | null;
    androidVersionCode: number | null;
    linux: string | null;
  };
  releases: Release[];
}

const platformList = (release: Release): string => {
  const parts: string[] = [];
  if (release.windows) parts.push('Windows');
  if (release.android) parts.push('Android');
  if (release.deb || release.targz) parts.push('Linux');
  return parts.length ? parts.join(', ') : 'нет сборок';
};

export default function ReleaseRollbackPanel() {
  const [state, setState] = useState<ReleasesState | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const { data } = await superAdminApi.get('/superadmin/releases');
      setState(data);
      setError('');
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Не удалось получить список сборок');
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const activate = async (release: Release) => {
    const warning = `Сделать ${release.version} текущей версией?\n\n`
      + 'Windows-клиенты откатятся сами при следующей проверке обновлений.\n'
      + 'Android так откатить нельзя: система запрещает ставить APK с меньшим '
      + 'номером сборки поверх большего — старую версию получат только новые установки.';
    if (!window.confirm(warning)) return;

    setBusy(true);
    setStatus('');
    try {
      const { data } = await superAdminApi.post('/superadmin/releases/activate', { version: release.version });
      setState(data.state);
      setError('');
      const parts = [`Текущей стала ${data.version} (${data.changed.join(', ')})`];
      // Пропущенные платформы показываем рядом с успехом, а не молчим о них:
      // «откатилось» и «откатилось наполовину» — разные вещи.
      if (data.skipped?.length) parts.push(`Без изменений: ${data.skipped.join('; ')}`);
      setStatus(parts.join('. '));
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Не удалось переключить версию');
    } finally {
      setBusy(false);
    }
  };

  if (state && !state.available) {
    return (
      <div className="sa-card sa-card--compact">
        <h2>Версии и откат</h2>
        <p className="sa-hint">
          Каталог раздачи недоступен на этом сервере ({state.dir}) — откат работает
          только там, где лежат сами сборки.
        </p>
      </div>
    );
  }

  return (
    <div className="sa-card sa-card--compact">
      <h2>Версии и откат</h2>
      {error && <p className="form-error">{error}</p>}

      <p className="sa-hint">
        Откат переписывает манифесты раздачи на выбранную сборку. Сами файлы
        остаются на сервере, поэтому вернуться можно в обе стороны.
      </p>
      <p className="sa-hint">
        Windows откатывается сам при очередной проверке обновлений. На Android
        откат действует только для новых установок: система не даёт поставить
        сборку с меньшим номером поверх большей.
      </p>

      {!state && <p className="sa-hint">Загрузка…</p>}

      {state && (
        <div className="sa-releases">
          {state.releases.map((release) => {
            const isCurrent = state.current.windows === release.version
              || state.current.android === release.version;
            return (
              <div key={release.version} className={'sa-release' + (isCurrent ? ' is-current' : '')}>
                <div className="sa-release-meta">
                  <strong>{release.version}</strong>
                  <span className="sa-hint">
                    {platformList(release)}
                    {isCurrent && ' · раздаётся сейчас'}
                  </span>
                </div>
                {!isCurrent && (
                  <button
                    type="button"
                    className="sa-btn-ghost"
                    disabled={busy}
                    onClick={() => activate(release)}
                  >
                    Откатить сюда
                  </button>
                )}
              </div>
            );
          })}
          {state.releases.length === 0 && <p className="sa-hint">Сборок на сервере не найдено</p>}
        </div>
      )}

      {status && <p className="sa-hint">{status}</p>}
    </div>
  );
}
