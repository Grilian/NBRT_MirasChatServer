const db = require('../db');
const { notifyCalendar } = require('./push');

// Доставка уведомлений по задачам — тот же принцип, что и у календаря: сокет
// для тех, кто сейчас в приложении, пуш — чтобы дошло до свёрнутого телефона.
// notifyCalendar переиспользуем как есть: у неё нет ничего специфичного для
// календаря, кроме имени, — только type/title/body/id для тега уведомления.

function deliver(io, userId, payload) {
  if (io) io.to('user:' + userId).emit('task_notification', payload);
  notifyCalendar(userId, { ...payload, eventId: payload.taskId }).catch(() => { /* уже залогировано внутри */ });
}

/**
 * Сигнал «список задач изменился» всем причастным.
 *
 * Отдельно от уведомления: уведомление — это про «отвлекись, тебе поручили»,
 * а это про «перечитай список». Без него смена статуса другим человеком не
 * появлялась на экране, пока не переключишь вкладку и список не перезапросится.
 */
function notifyTasksChanged(io, taskId, creatorId) {
  if (!io) return;
  const participants = db.prepare('SELECT user_id FROM task_participants WHERE task_id = ?')
    .all(taskId).map((row) => row.user_id);
  const involved = new Set([creatorId, ...participants]);
  for (const userId of involved) io.to('user:' + userId).emit('tasks_changed', { taskId });
}

function creatorName(task) {
  const owner = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(task.created_by);
  return owner ? (owner.display_name || owner.username) : 'Коллега';
}

/** Новая задача — уведомляем причастных, кроме самого создателя. */
function notifyTaskCreated(io, task, participantIds) {
  if (!participantIds.length) return;
  const authorName = creatorName(task);

  for (const userId of participantIds) {
    if (userId === task.created_by) continue;
    deliver(io, userId, {
      type: 'task_assigned',
      taskId: task.id,
      title: `${authorName} поручил задачу`,
      body: task.title,
    });
  }
}

/** Кто-то сменил статус — уведомляем остальных причастных и автора. */
function notifyTaskStatusChanged(io, task, changedByUserId) {
  const participants = db.prepare('SELECT user_id FROM task_participants WHERE task_id = ?')
    .all(task.id).map((row) => row.user_id);
  const recipients = new Set([task.created_by, ...participants]);
  recipients.delete(changedByUserId);
  if (recipients.size === 0) return;

  const changer = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(changedByUserId);
  const changerName = changer ? (changer.display_name || changer.username) : 'Коллега';

  const STATUS_LABELS = { not_started: 'не начата', in_progress: 'в работе', done: 'готово' };
  const label = STATUS_LABELS[task.status] || task.status;

  for (const userId of recipients) {
    deliver(io, userId, {
      type: 'task_status_changed',
      taskId: task.id,
      title: task.title,
      body: `${changerName} отметил: ${label}`,
    });
  }
}

module.exports = { notifyTaskCreated, notifyTaskStatusChanged, notifyTasksChanged };
