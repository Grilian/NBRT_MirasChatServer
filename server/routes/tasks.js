const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const { notifyTaskCreated, notifyTaskStatusChanged, notifyTasksChanged } = require('../services/taskNotify');

const router = express.Router();

const STATUSES = new Set(['not_started', 'in_progress', 'done']);

function userBrief(id) {
  const row = db.prepare('SELECT id, username, display_name, avatar_path FROM users WHERE id = ?').get(id);
  if (!row) return null;
  return { id: row.id, username: row.username, display_name: row.display_name || row.username, avatar_path: row.avatar_path || null };
}

function participantsOf(taskId) {
  return db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_path
    FROM task_participants p
    JOIN users u ON u.id = p.user_id
    WHERE p.task_id = ?
    ORDER BY u.display_name COLLATE NOCASE
  `).all(taskId).map((row) => ({ ...row, display_name: row.display_name || row.username }));
}

function serializeTask(row, userId) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || null,
    status: row.status,
    due_at: row.due_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    created_by: userBrief(row.created_by),
    participants: participantsOf(row.id),
    can_edit: row.created_by === userId,
    archived: !!row.archived,
  };
}

/**
 * Задача, которую этот человек вправе видеть, — создатель или причастный.
 * Видимость строго по составу: организация большая (до пары сотен человек),
 * и без этого ограничения список быстро превратился бы в чужую свалку
 * поручений, среди которых свою не найти.
 */
function visibleTask(id, userId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return null;
  if (task.created_by === userId) return task;
  const participant = db.prepare('SELECT 1 FROM task_participants WHERE task_id = ? AND user_id = ?').get(id, userId);
  return participant ? task : null;
}

function replaceParticipants(taskId, participantIds) {
  db.prepare('DELETE FROM task_participants WHERE task_id = ?').run(taskId);
  const insert = db.prepare('INSERT OR IGNORE INTO task_participants (task_id, user_id) VALUES (?, ?)');
  const exists = db.prepare('SELECT 1 FROM users WHERE id = ?');
  for (const userId of participantIds) {
    if (!exists.get(userId)) continue;
    insert.run(taskId, userId);
  }
}

function parseParticipantIds(body) {
  return Array.isArray(body.participant_ids)
    ? [...new Set(body.participant_ids.map(Number).filter(Number.isFinite))]
    : [];
}

function parseTaskBody(body) {
  const title = String(body.title || '').trim();
  if (!title) return { error: 'Укажите название' };
  if (title.length > 200) return { error: 'Название слишком длинное' };

  const description = body.description ? String(body.description).slice(0, 4000) : null;

  let dueAt = null;
  if (body.due_at !== null && body.due_at !== undefined && body.due_at !== '') {
    const parsed = Number(body.due_at);
    if (!Number.isFinite(parsed)) return { error: 'Некорректный срок' };
    dueAt = parsed;
  }

  return { value: { title, description, due_at: dueAt }, participantIds: parseParticipantIds(body) };
}

// Свои задачи: те, что поставил сам, и те, куда причастен. Разделение на
// «Мне»/«От меня» делает клиент по created_by — тащить два отдельных запроса
// на сервер незачем, набор один и тот же.
// Архивные по умолчанию скрыты — это отдельный ?archived=1, чтобы основной
// список не зарастал завершёнными поручениями, которые уже убрали с глаз.
router.get('/', verifyToken, (req, res) => {
  try {
    const archived = req.query.archived === '1' ? 1 : 0;
    const rows = db.prepare(`
      SELECT DISTINCT t.*
      FROM tasks t
      LEFT JOIN task_participants p ON p.task_id = t.id
      WHERE (t.created_by = ? OR p.user_id = ?) AND t.archived = ?
      ORDER BY
        (t.status = 'done'),
        (t.due_at IS NULL), t.due_at,
        t.created_at DESC
    `).all(req.userId, req.userId, archived);

    res.json(rows.map((row) => serializeTask(row, req.userId)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', verifyToken, (req, res) => {
  try {
    const parsed = parseTaskBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const now = Date.now();
    const value = parsed.value;
    const result = db.prepare(`
      INSERT INTO tasks (title, description, created_by, status, due_at, created_at, updated_at)
      VALUES (?, ?, ?, 'not_started', ?, ?, ?)
    `).run(value.title, value.description, req.userId, value.due_at, now, now);

    const taskId = result.lastInsertRowid;
    const participantIds = parsed.participantIds.filter((id) => id !== req.userId);
    replaceParticipants(taskId, participantIds);

    const created = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    notifyTaskCreated(req.app.get('io'), created, participantIds);
    notifyTasksChanged(req.app.get('io'), taskId, req.userId);

    res.status(201).json(serializeTask(created, req.userId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Правка — только создатель: причастные видят и двигают статус, но не
// переписывают чужое поручение и не решают за автора, кто ещё в нём участвует.
router.put('/:id', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!task || task.created_by !== req.userId) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }

    const parsed = parseTaskBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const value = parsed.value;
    db.prepare(`
      UPDATE tasks SET title = ?, description = ?, due_at = ?, updated_at = ? WHERE id = ?
    `).run(value.title, value.description, value.due_at, Date.now(), id);

    // Считаем новичков до перезаписи списка — иначе после неё все выглядят
    // новыми, и уведомление ушло бы повторно всем причастным.
    const alreadyIn = new Set(
      db.prepare('SELECT user_id FROM task_participants WHERE task_id = ?').all(id).map((r) => r.user_id)
    );
    const nextParticipants = parsed.participantIds.filter((pid) => pid !== req.userId);
    replaceParticipants(id, nextParticipants);

    const saved = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    notifyTaskCreated(req.app.get('io'), saved, nextParticipants.filter((pid) => !alreadyIn.has(pid)));
    notifyTasksChanged(req.app.get('io'), id, saved.created_by);

    res.json(serializeTask(saved, req.userId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Смену статуса вправе делать любой причастный — задача может стоять на
// нескольких людях разом, и ждать именно автора, чтобы отметить готово,
// неудобно, когда сделал кто-то другой из причастных.
router.put('/:id/status', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = visibleTask(id, req.userId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });

    const status = String(req.body.status || '');
    if (!STATUSES.has(status)) return res.status(400).json({ error: 'Некорректный статус' });

    const now = Date.now();
    // Уводя статус обратно с "готово", снимаем и архив — архивная задача,
    // которая внезапно снова не done, была бы видна только тому, кто помнит,
    // что заглянуть надо именно во вкладку "Архив".
    db.prepare('UPDATE tasks SET status = ?, completed_at = ?, updated_at = ?, archived = CASE WHEN ? THEN archived ELSE 0 END WHERE id = ?')
      .run(status, status === 'done' ? now : null, now, status === 'done' ? 1 : 0, id);

    const saved = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    notifyTaskStatusChanged(req.app.get('io'), saved, req.userId);
    notifyTasksChanged(req.app.get('io'), id, saved.created_by);

    res.json(serializeTask(saved, req.userId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// В архив — только завершённую задачу, и только причастный (создатель тоже
// причастен по смыслу visibleTask). Убрать из архива можно тем же путём в
// обратную сторону, без ограничения по статусу.
router.put('/:id/archive', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = visibleTask(id, req.userId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });

    const archived = !!req.body.archived;
    if (archived && task.status !== 'done') {
      return res.status(400).json({ error: 'В архив можно переносить только завершённые задачи' });
    }

    db.prepare('UPDATE tasks SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, Date.now(), id);

    const saved = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    notifyTasksChanged(req.app.get('io'), id, saved.created_by);

    res.json(serializeTask(saved, req.userId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!task || task.created_by !== req.userId) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }

    // Сигнал шлём до удаления: после него состав причастных уже не собрать
    // (task_participants уходит каскадом).
    notifyTasksChanged(req.app.get('io'), id, task.created_by);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
