const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const { isParticipant, selfChatId } = require('../services/chatParticipants');
const { fileCategory } = require('../utils/fileCategory');

const router = express.Router();

// Раздел «Файлы» — личное хранилище человека.
//
// Это НЕ вложения одной переписки (те живут в карточке чата и отбираются по
// chat_id). Здесь всё, что человек отправил САМ, из всех чатов сразу: он
// пришёл сюда управлять своими файлами, а не искать их по перепискам. Отсюда и
// отбор по sender_id, а не по участию в чате.
//
// Чужие файлы в раздел не попадают намеренно: распоряжаться (удалять) можно
// только своим, а «показать, но ничего не дать сделать» — это второй список
// вложений, который уже есть в карточке собеседника.

/** Человекочитаемое имя чата, где лежит файл. */
function chatLabel(chatId, userId) {
  if (chatId === 'general') return { name: 'Общий чат', kind: 'general' };
  if (chatId === selfChatId(userId)) return { name: 'Избранное', kind: 'self' };

  const group = /^group_(\d+)$/.exec(String(chatId));
  if (group) {
    const row = db.prepare('SELECT name FROM chat_groups WHERE id = ?').get(Number(group[1]));
    return { name: row ? row.name : 'Группа', kind: 'group' };
  }

  const direct = /^chat_(\d+)_(\d+)$/.exec(String(chatId));
  if (direct) {
    const other = Number(direct[1]) === Number(userId) ? Number(direct[2]) : Number(direct[1]);
    const row = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(other);
    return { name: row ? (row.display_name || row.username) : 'Переписка', kind: 'direct' };
  }

  return { name: 'Переписка', kind: 'other' };
}

const SORTS = {
  new: 'm.id DESC',
  old: 'm.id ASC',
  big: 'size DESC',
  name: 'name COLLATE NOCASE ASC',
};

/**
 * Свои файлы: и документы, и картинки из переписки.
 *
 * Картинки тоже считаются файлами — они точно так же занимают место на диске,
 * и «убрать за собой» человек приходит именно за ними. Различаются они видом
 * (`kind`), от которого зависит показ: у картинки есть превью.
 */
router.get('/', verifyToken, (req, res) => {
  try {
    const archived = req.query.archived === '1';
    const sort = SORTS[req.query.sort] || SORTS.new;
    const search = String(req.query.search || '').trim().toLowerCase();

    // Удалённое сообщение не отдаёт вложение никуда, включая этот раздел.
    const rows = db.prepare(`
      SELECT m.id, m.chat_id, m.created_at, m.attachment_archived_at,
             m.document_path, m.document_name, m.document_size, m.document_mime,
             m.file_path, m.file_width, m.file_height,
             COALESCE(m.document_name, '') AS name,
             COALESCE(m.document_size, 0) AS size
      FROM messages m
      WHERE m.sender_id = ? AND m.deleted = 0
        AND (m.document_path IS NOT NULL OR m.file_path IS NOT NULL)
        AND m.attachment_archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
      ORDER BY ${sort}
      LIMIT 500
    `).all(req.userId);

    const items = [];
    for (const row of rows) {
      const isImage = !row.document_path && !!row.file_path;
      // Имя картинки в переписке не спрашивают — показываем осмысленное вместо
      // msg_39_1786…webp, по которому ничего не понять.
      const name = row.document_name
        || (isImage ? `Изображение от ${String(row.created_at).slice(0, 10)}` : 'Файл');
      if (search && !name.toLowerCase().includes(search)) continue;

      const chat = chatLabel(row.chat_id, req.userId);
      items.push({
        message_id: row.id,
        kind: isImage ? 'image' : 'document',
        name,
        path: row.document_path || row.file_path,
        size: row.document_size,
        mime: row.document_mime,
        width: row.file_width,
        height: row.file_height,
        category: isImage ? 'images' : fileCategory(row.document_name, row.document_mime),
        created_at: row.created_at,
        chat_id: row.chat_id,
        chat_name: chat.name,
        chat_kind: chat.kind,
        archived_at: row.attachment_archived_at || null,
        // Доступ к самому чату мог пропасть (вывели из группы) — тогда
        // «перейти к сообщению» показывать нечем, и кнопки быть не должно.
        can_open: isParticipant(row.chat_id, req.userId),
      });
    }

    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Сколько места занято и чем.
 *
 * Считается по ВСЕМ своим файлам, а не по показанной странице: смысл сводки
 * ровно в том, чтобы человек увидел, что съедает место, и решил, что убрать.
 * У картинок размер в БД не хранится (там ширина и высота), поэтому в байтах
 * учитываются только документы, а картинки идут отдельным счётчиком — врать
 * про общий объём хуже, чем честно показать две величины.
 */
router.get('/summary', verifyToken, (req, res) => {
  try {
    const documents = db.prepare(`
      SELECT document_name AS name, document_mime AS mime, COALESCE(document_size, 0) AS size
      FROM messages
      WHERE sender_id = ? AND deleted = 0 AND document_path IS NOT NULL
        AND attachment_archived_at IS NULL
    `).all(req.userId);

    const byCategory = { documents: 0, files: 0, images: 0, music: 0 };
    const countByCategory = { documents: 0, files: 0, images: 0, music: 0 };
    let totalBytes = 0;
    for (const row of documents) {
      const category = fileCategory(row.name, row.mime);
      byCategory[category] += row.size;
      countByCategory[category] += 1;
      totalBytes += row.size;
    }

    const images = db.prepare(`
      SELECT COUNT(*) AS c FROM messages
      WHERE sender_id = ? AND deleted = 0 AND file_path IS NOT NULL
        AND attachment_archived_at IS NULL
    `).get(req.userId).c;
    countByCategory.images += images;

    const archived = db.prepare(`
      SELECT COUNT(*) AS c FROM messages
      WHERE sender_id = ? AND deleted = 0 AND attachment_archived_at IS NOT NULL
    `).get(req.userId).c;

    res.json({
      total_bytes: totalBytes,
      documents_count: documents.length,
      images_count: images,
      archived_count: archived,
      bytes_by_category: byCategory,
      count_by_category: countByCategory,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
