import React, { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import Avatar from './Avatar';
import { nameFor } from '../utils/user';
import { formatDate } from '../utils/time';
import { describeStatus } from '../utils/statusMeta';

export interface DirectoryUser {
  id: number;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  group_id: number | null;
  group_name: string | null;
  status_preset?: string | null;
  status_custom?: string | null;
  /** Когда человек завёл учётную запись — 'YYYY-MM-DD HH:MM:SS' от SQLite. */
  created_at?: string | null;
}

interface PeopleSectionProps {
  currentUserId: number;
  existingContactIds: number[];
  onlineUserIds: number[];
  onOpenChat: (user: DirectoryUser) => void;
  onOpenUserInfo: (userId: number) => void;
  onAddContact: (user: DirectoryUser) => void;
  /** Закрыть окно — раздел открывается модалкой поверх текущего экрана. */
  onClose: () => void;
}

/** «с 12.03.2025» — дата регистрации в справочнике. */
function registeredLabel(createdAt: string | null | undefined): string | null {
  if (!createdAt) return null;
  const day = String(createdAt).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `с ${formatDate(day)}` : null;
}

const NO_GROUP = 'Без подразделения';

function pluralPeople(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} сотрудник`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} сотрудника`;
  return `${n} сотрудников`;
}

// Раздел «Люди» — тот же справочник, что и в модальном окне «+», но во весь
// экран и с группировкой по подразделениям: из рельса им пользуются не чтобы
// быстро начать чат, а чтобы посмотреть, кто вообще есть в организации.
const PeopleSection: React.FC<PeopleSectionProps> = ({
  currentUserId, existingContactIds, onlineUserIds, onOpenChat, onOpenUserInfo, onAddContact, onClose
}) => {
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get('/users')
      .then(({ data }) => { if (!cancelled) setUsers(data); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = users
      .filter((u) => u.id !== currentUserId)
      .filter((u) => {
        if (!needle) return true;
        return (
          nameFor(u).toLowerCase().includes(needle) ||
          (u.group_name || '').toLowerCase().includes(needle)
        );
      });

    const byGroup = new Map<string, DirectoryUser[]>();
    matched.forEach((u) => {
      const key = u.group_name || NO_GROUP;
      const list = byGroup.get(key);
      if (list) list.push(u); else byGroup.set(key, [u]);
    });

    return Array.from(byGroup.entries())
      // «Без подразделения» всегда последним, остальные по алфавиту
      .sort((a, b) => {
        if (a[0] === NO_GROUP) return 1;
        if (b[0] === NO_GROUP) return -1;
        return a[0].localeCompare(b[0], 'ru');
      })
      .map(([label, list]) => ({
        label,
        users: list.sort((a, b) => nameFor(a).localeCompare(nameFor(b), 'ru')),
      }));
  }, [users, query, currentUserId]);

  const total = groups.reduce((sum, g) => sum + g.users.length, 0);

  return (
    <div className="section-pane">
      <div className="conv-head">
        <div className="conv-title">
          <div className="name">Люди</div>
          <div className="status">
            {loading ? 'Загрузка…' : pluralPeople(total)}
          </div>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="section-scroll">
        <div className="section-column">
          <div className="search people-search">
            <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              type="text"
              placeholder="Поиск по имени или подразделению"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {error && <div className="roster-empty">Не удалось загрузить справочник</div>}
          {!loading && !error && total === 0 && <div className="roster-empty">Ничего не найдено</div>}

          {groups.map((group) => (
            <React.Fragment key={group.label}>
              <div className="roster-section">{group.label}</div>
              {group.users.map((user) => (
                <div
                  key={user.id}
                  className="row directory-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenChat(user)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenChat(user); } }}
                >
                  <button
                    type="button"
                    className="row-avatar-btn"
                    onClick={(e) => { e.stopPropagation(); onOpenUserInfo(user.id); }}
                    aria-label="Профиль"
                  >
                    <Avatar
                      name={nameFor(user)}
                      avatarPath={user.avatar_path}
                      online={onlineUserIds.includes(user.id)}
                    />
                  </button>
                  <div className="row-body">
                    <div className="row-top">
                      <div className="row-name"><span>{nameFor(user)}</span></div>
                      {(() => {
                        const status = describeStatus(user.status_preset, user.status_custom);
                        return status && (
                          <span className="people-tag is-status" title={status.label}>{status.emoji} {status.label}</span>
                        );
                      })()}
                    </div>
                    <div className="row-bottom">
                      <div className="row-preview">
                        {onlineUserIds.includes(user.id) ? 'в сети' : `@${user.username}`}
                        {registeredLabel(user.created_at) && (
                          <span className="people-registered"> · {registeredLabel(user.created_at)}</span>
                        )}
                      </div>
                      <div className="row-actions">
                        {existingContactIds.includes(user.id) ? (
                          <span className="people-tag">в чатах</span>
                        ) : (
                          <button
                            type="button"
                            className="people-add-btn"
                            onClick={(e) => { e.stopPropagation(); onAddContact(user); }}
                            title="Добавить в контакты"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 5v14M5 12h14" /></svg>
                            Добавить
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
};

export default PeopleSection;
