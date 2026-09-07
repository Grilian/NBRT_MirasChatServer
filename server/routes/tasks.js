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
    // Ответственный. Один и передаваемый — решение пользователя от 07.09.2026:
    // «задача может перемещаться от исполнителя к исполнителю». null — задача
    // ещё никому не поручена, и тогда её видят все причастные: иначе взять её
    // было бы некому.
    assignee: row.assignee_id ? userBrief(row.assignee_id) : null,
    participants: participantsOf(row.id),
    source: {
      kind: row.source_kind || 'manual',
      ref: row.source_ref || null,
      label: row.source_label || null,
    },
    can_edit: row.created_by === userId,
    // Передать задачу вправе постановщик или ТЕКУЩИЙ исполнитель: сдать свою
    // работу другому — нормальный ход, а наблюдатель не решает, с кого спрос.
    can_assign: row.created_by === userId || row.assignee_id === userId,
    archived: !!row.archived,
    deleted: !!row.deleted_at,
  };
}

/**
 * Задача, которую этот человек вправе видеть, — создатель или причастный.
 * Видимость строго по составу: организация большая (до пары сотен человек),
 * и без этого ограничения список быстро превратился бы в чужую свалку
 * поручений, среди которых свою не найти.
 */
function visibleTask(id, userId, { includeDeleted = false } = {}) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return null;
  // Удалённая задача пропадает из всех обычных выдач: строка осталась ради
  // журнала и восстановления, а не чтобы продолжать жить в списках.
  if (task.deleted_at && !includeDeleted) return null;
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

  // Источник. Настоящих значений два: задача заведена руками или пришла из
  // переписки. 'order' (заказ книг) в схеме заложен, но сюда не принимается —
  // внешней базы пока нет даже в договорённостях, и принимать источник,
  // которого не существует, значит завести данные, которым нечем управлять.
  const sourceKind = body.source_kind === 'chat' ? 'chat' : 'manual';
  const sourceRef = sourceKind === 'chat' && body.source_ref ? String(body.source_ref).slice(0, 100) : null;
  const sourceLabel = sourceKind === 'chat' && body.source_label ? String(body.source_label).slice(0, 200) : null;

  return {
    value: {
      title, description, due_at: dueAt,
      source_kind: sourceKind, source_ref: sourceRef, source_label: sourceLabel,
    },
    participantIds: parseParticipantIds(body),
    assigneeId: Number.isFinite(Number(body.assignee_id)) ? Number(body.assignee_id) : null,
  };
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
      WHERE (t.created_by = ? OR p.user_id = ?) AND t.archived = ? AND t.deleted_at IS NULL
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
      INSERT INTO tasks (
        title, description, created_by, status, due_at, created_at, updated_at,
        assignee_id, source_kind, source_ref, source_label
      )
      VALUES (?, ?, ?, 'not_started', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.title, value.description, req.userId, value.due_at, now, now,
      parsed.assigneeId, value.source_kind, value.source_ref, value.source_label
    );

    const taskId = result.lastInsertRowid;
    // Исполнитель обязан быть и в причастных: видимость считается по ним, и
    // назначенный, но не причастный человек своей же задачи не увидел бы.
    const participantIds = [...new Set([
      ...parsed.participantIds,
      ...(parsed.assigneeId ? [parsed.assigneeId] : []),
    ])].filter((id) => id !== req.userId);
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
    if (!task || task.deleted_at || task.created_by !== req.userId) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }

    const parsed = parseTaskBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const value = parsed.value;
    // Источник при правке НЕ меняется: он отвечает на вопрос «откуда задача
    // взялась», а это факт прошлого. Исполнитель меняется своей ручкой ниже —
    // передача задачи это не то же самое, что правка текста.
    db.prepare(`
      UPDATE tasks SET title = ?, description = ?, due_at = ?, updated_at = ? WHERE id = ?
    `).run(value.title, value.description, value.due_at, Date.now(), id);

    // Считаем новичков до перезаписи списка — иначе после неё все выглядят
    // новыми, и уведомление ушло бы повторно всем причастным.
    const alreadyIn = new Set(
      db.prepare('SELECT user_id FROM task_participants WHERE task_id = ?').all(id).map((r) => r.user_id)
    );
    const nextParticipants = parsed.participantIds.filter((pid) => pid !== req.userId);
    const nextParticipantSet = new Set(nextParticipants);
    const removedParticipants = [...alreadyIn].filter((pid) => !nextParticipantSet.has(pid));
    replaceParticipants(id, nextParticipants);

    const saved = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    notifyTaskCreated(req.app.get('io'), saved, nextParticipants.filter((pid) => !alreadyIn.has(pid)));
    // Удалённые участники уже отсутствуют в таблице, но их открытый клиент
    // тоже должен перечитать список и убрать ставшую невидимой задачу.
    notifyTasksChanged(req.app.get('io'), id, saved.created_by, removedParticipants);

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

/**
 * Передать задачу другому исполнителю.
 *
 * Отдельной ручкой, а не полем в общей правке: правку целиком делает только
 * постановщик, а сдать работу другому вправе и текущий исполнитель — это
 * разные права, и смешивать их в одном обработчике значит либо запретить
 * передачу исполнителю, либо открыть ему правку чужого поручения.
 *
 * `assignee_id: null` — снять исполнителя: задача возвращается в общий пул и
 * видна всем причастным.
 */
router.put('/:id/assignee', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = visibleTask(id, req.userId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });
    if (task.created_by !== req.userId && task.assignee_id !== req.userId) {
      return res.status(403).json({ error: 'Передать задачу может постановщик или текущий исполнитель' });
    }

    const raw = req.body.assignee_id;
    const assigneeId = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    if (assigneeId !== null && !Number.isFinite(assigneeId)) {
      return res.status(400).json({ error: 'Некорректный исполнитель' });
    }
    if (assigneeId !== null && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(assigneeId)) {
      return res.status(400).json({ error: 'Такого сотрудника нет' });
    }

    db.prepare('UPDATE tasks SET assignee_id = ?, updated_at = ? WHERE id = ?')
      .run(assigneeId, Date.now(), id);
    // Новый исполнитель обязан стать причастным, иначе он не увидит того, что
    // ему поручили: видимость считается по составу причастных.
    if (assigneeId !== null && assigneeId !== task.created_by) {
      db.prepare('INSERT OR IGNORE INTO task_participants (task_id, user_id) VALUES (?, ?)').run(id, assigneeId);
    }

    const saved = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    notifyTasksChanged(req.app.get('io'), id, saved.created_by);
    res.json(serializeTask(saved, req.userId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Удаление задачи — МЯГКОЕ, с обязательной причиной.
 *
 * Раньше строка стиралась физически и только автором. Теперь удалить может
 * любой причастный (решение пользователя от 07.09.2026), а значит задача может
 * исчезнуть у постановщика без его ведома — и журнал с причиной тут
 * единственная защита. Пустая причина заполнила бы журнал строками, по которым
 * ничего не понять, то есть отменила бы его смысл; поэтому 400, а не молчание.
 *
 * Статус на момент удаления запоминается отдельной колонкой: восстановленная
 * задача живёт дальше и статус меняет, а журнал обязан показывать то, что было
 * в минуту удаления.
 */
router.delete('/:id', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = visibleTask(id, req.userId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });

    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Укажите причину удаления' });
    if (reason.length > 200) return res.status(400).json({ error: 'Причина слишком длинная' });

    db.prepare(`
      UPDATE tasks
         SET deleted_at = ?, deleted_by = ?, delete_reason = ?, deleted_status = status, updated_at = ?
       WHERE id = ?
    `).run(Date.now(), req.userId, reason, Date.now(), id);

    notifyTasksChanged(req.app.get('io'), id, task.created_by);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Журнал удалений: свои задачи.
 *
 * «Все причастные — по своим задачам» (решение пользователя). Раз удалить
 * может любой, автор обязан увидеть, куда делась его задача и почему; чужие
 * удаления при этом никого не касаются.
 */
router.get('/journal', verifyToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT t.*
      FROM tasks t
      LEFT JOIN task_participants p ON p.task_id = t.id
      WHERE t.deleted_at IS NOT NULL AND (t.created_by = ? OR p.user_id = ?)
      ORDER BY t.deleted_at DESC
    `).all(req.userId, req.userId);

    res.json(rows.map((row) => ({
      ...serializeTask(row, req.userId),
      deleted_at: row.deleted_at,
      deleted_by: userBrief(row.deleted_by),
      delete_reason: row.delete_reason,
      // Статус на момент удаления, а не текущий: см. комментарий у DELETE.
      deleted_status: row.deleted_status || row.status,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Вернуть удалённую задачу.
 *
 * Возврат почти бесплатен (удаление мягкое) и исправляет ровно ту ошибку,
 * которую открывает право «удалить может любой»: убрал чужую задачу не глядя.
 * Сама запись из журнала не стирается — журнал отвечает на «что происходило», и
 * подчистить его значит снова остаться без ответа.
 */
router.put('/:id/restore', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = visibleTask(id, req.userId, { includeDeleted: true });
    if (!task || !task.deleted_at) return res.status(404).json({ error: 'Задача не найдена' });

    db.prepare(`
      UPDATE tasks
         SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, deleted_status = NULL, updated_at = ?
       WHERE id = ?
    `).run(Date.now(), id);

    const saved = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    notifyTasksChanged(req.app.get('io'), id, saved.created_by);
    res.json(serializeTask(saved, req.userId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
