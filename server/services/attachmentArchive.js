const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const db = require('../db');
const userStorage = require('./userStorage');

// Убрать вложение = положить его в zip, а не стереть.
//
// Требование пользователя буквально: «файлы вместо удаления архивируются,
// пропадают у пользователя из приложения, на диске они переходят в zip». Это
// же единственный способ выполнить требование к удалению и не нарушить
// обязательство хранить переписку: содержимое остаётся на диске (только
// сжатым и вне живого дерева), а из приложения вложение исчезает у всех.
//
// Само сообщение при этом НЕ удаляется и не помечается удалённым: текст,
// ответы и реакции на месте, пропадает только вложение. Обратной операции нет
// намеренно — «архивировать» должно звучать окончательно, иначе оно ничем не
// отличается от «скрыть».

/** Один zip на вложение, а не общий растущий архив. */
function archiveNameFor(originalName, filename) {
  const base = String(originalName || filename || 'file')
    .replace(/[/\\]/g, '_')
    .slice(0, 120);
  return `${Date.now()}_${base.replace(/\.zip$/i, '')}.zip`;
}

/**
 * Кто может убрать вложение.
 *
 * Отправитель — всегда своё. Организационная администрация — любое: те же
 * права, что у удаления чужих сообщений (canDeleteForEveryone в index.js), и
 * разъезжаться этим двум наборам незачем.
 */
function canArchive(message, userId) {
  if (!message) return false;
  if (message.sender_id === userId) return true;
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  return !!user && (user.role === 'admin' || user.role === 'moderator');
}

class ArchiveError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Убрать вложение сообщения в архив.
 *
 * Порядок: сначала пишем zip, потом правим строку, и только потом удаляем
 * исходник. Падение между шагами оставляет лишний файл на диске, но никогда —
 * строку, ссылающуюся в пустоту.
 */
function archiveAttachment(messageId, userId) {
  const message = db.prepare(`
    SELECT id, chat_id, sender_id, file_path, document_path, document_name, attachment_archived_at
    FROM messages WHERE id = ?
  `).get(Number(messageId));

  if (!message) throw new ArchiveError('Сообщение не найдено', 404);
  if (!canArchive(message, userId)) throw new ArchiveError('Можно убирать только свои файлы', 403);
  if (message.attachment_archived_at) throw new ArchiveError('Вложение уже убрано', 409);

  const source = message.document_path || message.file_path;
  if (!source) throw new ArchiveError('В этом сообщении нет вложения');

  // Владелец файла, а не тот, кто нажал: администратор убирает чужое вложение,
  // и архив обязан лечь в папку того, чьё место он занимает.
  const parsed = userStorage.parseUserPath(source);
  const ownerId = parsed ? parsed.userId
    : (userStorage.ownerFromFilename(path.basename(source)) || message.sender_id);

  const abs = userStorage.absoluteFromPublic(source);
  const filename = path.basename(source);
  const entryName = message.document_name || filename;

  const archiveDir = userStorage.userDir(ownerId, 'archive');
  const archiveFile = archiveNameFor(message.document_name, filename);
  const archiveAbs = path.join(archiveDir, archiveFile);

  if (abs && fs.existsSync(abs)) {
    const zip = new AdmZip();
    // Имя внутри архива — то, под которым файл отправляли: распаковавший
    // должен получить «смета за август.pdf», а не doc_7_1755…_9f3c.pdf.
    zip.addLocalFile(abs, '', entryName);
    zip.writeZip(archiveAbs);
  } else {
    // Файла на диске уже нет (пропал раньше). Убрать вложение из приложения
    // всё равно нужно — иначе останется битая картинка, которую ничем не
    // убрать. Пустого архива при этом не пишем: пустой zip выглядел бы как
    // сохранённый файл, которого на самом деле нет.
  }

  const archivedPath = fs.existsSync(archiveAbs)
    ? userStorage.publicPath(ownerId, 'archive', archiveFile)
    : null;

  db.prepare(`
    UPDATE messages
    SET attachment_archived_at = ?, attachment_archive_path = ?
    WHERE id = ?
  `).run(Date.now(), archivedPath, message.id);

  if (abs && fs.existsSync(abs)) {
    // Тот же файл может стоять в пересланной копии — тогда исходник оставляем:
    // человек убирал своё вложение, а не чужое сообщение.
    const stillUsed = db.prepare(`
      SELECT 1 FROM messages
      WHERE (file_path = ? OR document_path = ?) AND id != ? AND attachment_archived_at IS NULL
      LIMIT 1
    `).get(source, source, message.id);
    if (!stillUsed) {
      try { fs.unlinkSync(abs); } catch { /* уже нет */ }
    }
  }

  return {
    id: message.id,
    chat_id: message.chat_id,
    archived_at: Date.now(),
    archive_path: archivedPath,
  };
}

module.exports = { archiveAttachment, canArchive, ArchiveError };
