import React from 'react';
import { AccountType } from '@/shared/lib/accountMeta';
import { formatMoscowDateTime } from '@/shared/lib/time';

// Общие типы панели управления. Вынесены из SuperAdminApp, чтобы каждая
// вкладка жила своим файлом: монолит на 1557 строк был последним местом в
// проекте, где «найти нужное» означало пролистать всё.

export interface Group {
  id: number;
  name: string;
  member_count: number;
}

export type PasswordStatus = 'ok' | 'pending' | 'expired';

export interface UserRow {
  id: number;
  username: string;
  display_name: string | null;
  group_id: number | null;
  group_name: string | null;
  role: 'user' | 'moderator' | 'admin' | null;
  muted: boolean;
  account_type: AccountType;
  department_id: number | null;
  department_name: string | null;
  password_status: PasswordStatus;
  /** Может отсутствовать, если панель открыта против сервера постарше. */
  app_versions?: AppVersion[];
  /** 'YYYY-MM-DD HH:MM:SS' от SQLite — по нему считается метка New. */
  created_at?: string | null;
}

export interface AppVersion {
  platform: 'desktop' | 'android' | 'web';
  version: string;
  updated_at: number;
}

export const PLATFORM_LABELS: Record<string, string> = {
  desktop: 'ПК',
  android: 'Android',
  web: 'Веб',
};

// Фиксированный порядок платформ: иначе строки таблицы перемешивались бы
// в зависимости от того, откуда человек заходил последним, и колонку стало бы
// невозможно читать сверху вниз.
export const PLATFORM_ORDER = ['desktop', 'android', 'web'];

/**
 * Версии приложений у одного человека. Их может быть несколько: десктоп на
 * работе и телефон в кармане — это разные установки с разными версиями,
 * и при раскатке важно видеть обе.
 */
export function AppVersions({ versions }: { versions?: AppVersion[] }) {
  if (!versions || versions.length === 0) {
    return (
      <span
        className="sa-version is-old"
        title="Клиент не сообщает версию: сборка старше этой возможности либо человек с тех пор не заходил"
      >
        old
      </span>
    );
  }

  const sorted = [...versions].sort(
    (a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform)
  );

  return (
    <div className="sa-versions">
      {sorted.map((item) => (
        <span
          key={item.platform}
          className="sa-version"
          title={`Отчитался ${formatMoscowDateTime(item.updated_at)}`}
        >
          <span className="sa-version-platform">
            {PLATFORM_LABELS[item.platform] || item.platform}
          </span>
          {item.version}
        </span>
      ))}
    </div>
  );
}

export const PASSWORD_STATUS_LABELS: Record<Exclude<PasswordStatus, 'ok'>, string> = {
  pending: 'Ждёт нового пароля',
  expired: 'Недействителен',
};

