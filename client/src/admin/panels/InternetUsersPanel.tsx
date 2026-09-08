import React, { useEffect, useState } from 'react';
import superAdminApi from '@/shared/api/superAdminClient';
import { Group, UserRow } from '../types';
import UsersPanel from './UsersPanel';

export default function InternetUsersPanel({
  users, groups, departments, onChanged,
}: {
  users: UserRow[];
  groups: Group[];
  departments: Group[];
  onChanged: () => void;
}) {
  const [seenAt, setSeenAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    superAdminApi.get('/superadmin/internet-seen')
      .then(({ data }) => { if (!cancelled) setSeenAt(data.seenAt || 0); })
      .catch(() => { if (!cancelled) setSeenAt(0); });

    // Уход с вкладки = «разобрал». Отмечаем на размонтировании, а не по
    // таймеру: иначе метка снималась бы у человека, который просто открыл
    // вкладку и отошёл, не посмотрев список.
    return () => {
      cancelled = true;
      superAdminApi.put('/superadmin/internet-seen').catch(() => {});
    };
  }, []);

  const internetUsers = users.filter((u) => u.account_type === 'internet');

  // Пока не знаем момент последнего разбора — не мигаем метками: иначе при
  // каждом открытии вкладки на мгновение «новыми» выглядели бы все.
  const isNew = (user: UserRow) => {
    if (seenAt === null || !user.created_at) return false;
    const ms = Date.parse(user.created_at.replace(' ', 'T') + 'Z');
    return Number.isFinite(ms) && ms > seenAt;
  };

  const newCount = internetUsers.filter(isNew).length;

  return (
    <div className="sa-card">
      <p className="sa-hint">
        Регистрации с улицы. Они видят только других «Интернет» и группу «Админы»,
        пока их не подтвердят: смените тип на «Сотрудник» в колонке «Тип».
        {newCount > 0 && ` Новых с прошлого раза: ${newCount}.`}
      </p>

      {internetUsers.length === 0
        ? <p className="sa-hint">Пока никого.</p>
        : (
          <UsersPanel
            users={internetUsers}
            groups={groups}
            departments={departments}
            onChanged={onChanged}
            newUserIds={internetUsers.filter(isNew).map((u) => u.id)}
            embedded
          />
        )}
    </div>
  );
}

// ===== Google Календарь =====
