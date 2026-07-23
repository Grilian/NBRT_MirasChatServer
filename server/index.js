require('dotenv').config({ quiet: true });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const verifyToken = require('./middleware/verifyToken');
const userRoutes = require('./routes/users');
const unreadRoutes = require('./routes/unread');
const favoritesRoutes = require('./routes/favorites');
const commentsRoutes = require('./routes/comments');
const superadminRoutes = require('./routes/superadmin');
const { participantsForChatId } = require('./services/chatParticipants');

const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// REST API
app.use('/api/auth', authRoutes);
app.use('/api/messages', verifyToken, messageRoutes);
app.use('/api/users', userRoutes);
app.use('/api/unread', unreadRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/superadmin', superadminRoutes);

const server = http.createServer(app);
const io = new Server(server, {
  path: process.env.SOCKET_IO_PATH || '/MirasChatServer/socket.io',
  cors: {
    origin: '*'
  }
});

// Нужен маршрутам панели супер-админа, чтобы толкать живые обновления
// (например, режим тишины) в комнату конкретного пользователя — не бродкаст
// пользовательских данных всем подряд, а адресный пуш от доверенного
// серверного действия, поэтому это не повторяет ранее убранную уязвимость.
app.set('io', io);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// extraUserId — отправитель добавляется в комнату явно, иначе не получал бы
// эхо собственного сообщения/правки/удаления.
function emitToChat(chatId, event, payload, extraUserId) {
  const participants = participantsForChatId(chatId);
  if (participants === null) {
    io.emit(event, payload);
    return;
  }
  const rooms = new Set(participants.map((id) => 'user:' + id));
  if (extraUserId !== undefined && extraUserId !== null) rooms.add('user:' + extraUserId);
  if (rooms.size) io.to([...rooms]).emit(event, payload);
}

function broadcastToChat(socket, chatId, event, payload) {
  const participants = participantsForChatId(chatId);
  if (participants === null) {
    socket.broadcast.emit(event, payload);
  } else if (participants.length) {
    socket.to(participants.map((id) => 'user:' + id)).emit(event, payload);
  }
}

// ===== WebSocket =====
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log(`Подключен: ${socket.id}`);

  socket.on('user_online', (userId) => {
    onlineUsers.set(userId, socket.id);
    socket.userId = userId;
    socket.join('user:' + userId);
    io.emit('online_users', Array.from(onlineUsers.keys()));
  });

  socket.on('chat_message', async (data) => {
    // Режим тишины — проверяем по authентичному socket.userId (из user_online),
    // а не по data.senderId, который просто присылает клиент и легко подделать.
    if (socket.userId) {
      const senderRow = db.prepare('SELECT muted FROM users WHERE id = ?').get(socket.userId);
      if (senderRow && senderRow.muted) {
        socket.emit('message_blocked', { reason: 'muted', chatId: data.chatId });
        return;
      }
    }

    try {
      // Сохраняем в локальную БД
      const stmt = db.prepare(
        'INSERT INTO messages (chat_id, sender_id, text, status) VALUES (?, ?, ?, ?)'
      );
      const result = stmt.run(data.chatId, data.senderId, data.text, 'sent');

      const message = {
        id: result.lastInsertRowid,
        chat_id: data.chatId,
        sender_id: data.senderId,
        text: data.text,
        status: 'sent',
        created_at: new Date().toISOString()
      };

      emitToChat(data.chatId, 'chat_message', message, data.senderId);

      // Проверяем, есть ли получатель онлайн
      let recipientOnline = false;
      if (data.chatId === 'general') {
        recipientOnline = Array.from(onlineUsers.keys()).some(id => id !== data.senderId);
      } else {
        const match = data.chatId.match(/^chat_(\d+)_(\d+)$/);
        if (match) {
          const otherId = Number(match[1]) === data.senderId ? Number(match[2]) : Number(match[1]);
          recipientOnline = onlineUsers.has(otherId);
        }
      }

      if (recipientOnline) {
        db.prepare('UPDATE messages SET status = ? WHERE id = ?').run('delivered', result.lastInsertRowid);
        message.status = 'delivered';
        emitToChat(data.chatId, 'message_status', { id: result.lastInsertRowid, status: 'delivered' }, data.senderId);
      }
    } catch (e) {
      console.error('Ошибка:', e);
    }
  });

  socket.on('typing', (data) => {
    broadcastToChat(socket, data.chatId, 'typing', {
      chatId: data.chatId,
      userId: data.userId,
      username: data.username
    });
  });

  socket.on('stop_typing', (data) => {
    broadcastToChat(socket, data.chatId, 'stop_typing', {
      chatId: data.chatId,
      userId: data.userId
    });
  });

  socket.on('message_read', ({ chatId, messageIds }) => {

    if (!messageIds || messageIds.length === 0)
      return;

    const placeholders = messageIds.map(() => "?").join(",");

    db.prepare(`
        UPDATE messages
        SET status='read'
        WHERE id IN (${placeholders})
    `).run(...messageIds);

    emitToChat(chatId, "message_status_bulk", {
        chatId,
        messageIds,
        status: "read"
    });

  });

  socket.on('message_delivered', (messageId) => {
    try {
      const stmt = db.prepare('UPDATE messages SET status = ? WHERE id = ? AND status = ?');
      const result = stmt.run('delivered', messageId, 'sent');
      if (result.changes > 0) {
        const row = db.prepare('SELECT chat_id FROM messages WHERE id = ?').get(messageId);
        emitToChat(row ? row.chat_id : null, 'message_status', { id: messageId, status: 'delivered' });
      }
    } catch (e) {
      console.error('Ошибка обновления статуса:', e);
    }
  });

  // Разовая ручная "починка" застрявших счётчиков непрочитанного — например,
  // если бейдж повис из-за прежнего бага с широковещательной рассылкой личных
  // сообщений (см. приватность-фикс) или клиент просто не успел отметить
  // прочитанным вовремя. Помечаем читанными только те чаты, где сокет
  // реально участник — та же проверка, что и в emitToChat.
  socket.on('mark_all_read', () => {
    const userId = socket.userId;
    if (!userId) return;

    try {
      const candidates = db.prepare(
        "SELECT id, chat_id FROM messages WHERE sender_id != ? AND status != 'read'"
      ).all(userId);

      const byChat = {};
      for (const row of candidates) {
        const participants = participantsForChatId(row.chat_id);
        const isParticipant = participants === null || participants.includes(Number(userId));
        if (isParticipant) {
          (byChat[row.chat_id] = byChat[row.chat_id] || []).push(row.id);
        }
      }

      const allIds = Object.values(byChat).flat();
      if (!allIds.length) return;

      const placeholders = allIds.map(() => '?').join(',');
      db.prepare(`UPDATE messages SET status = 'read' WHERE id IN (${placeholders})`).run(...allIds);

      for (const [chatId, messageIds] of Object.entries(byChat)) {
        emitToChat(chatId, 'message_status_bulk', { chatId, messageIds, status: 'read' });
      }
    } catch (e) {
      console.error('Ошибка при массовой отметке прочитанного:', e);
    }
  });

  // Редактировать/удалить можно только своё сообщение — проверяем по
  // фактическому sender_id в БД, а не по тому, что прислал клиент (в отличие
  // от chat_message/senderId, здесь это разрушающее действие над чужими данными).
  socket.on('message_edit', ({ id, text }) => {
    try {
      const row = db.prepare('SELECT chat_id, sender_id, deleted FROM messages WHERE id = ?').get(id);
      if (!row || row.deleted || Number(row.sender_id) !== Number(socket.userId)) return;

      const trimmed = String(text || '').trim();
      if (!trimmed) return;

      const editedAt = new Date().toISOString();
      db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(trimmed, editedAt, id);

      emitToChat(row.chat_id, 'message_edited', {
        id,
        chat_id: row.chat_id,
        text: trimmed,
        edited_at: editedAt
      }, row.sender_id);
    } catch (e) {
      console.error('Ошибка редактирования сообщения:', e);
    }
  });

  socket.on('message_delete', ({ id }) => {
    try {
      const row = db.prepare('SELECT chat_id, sender_id FROM messages WHERE id = ?').get(id);
      if (!row || Number(row.sender_id) !== Number(socket.userId)) return;

      db.prepare("UPDATE messages SET deleted = 1, text = '' WHERE id = ?").run(id);

      emitToChat(row.chat_id, 'message_deleted', { id, chat_id: row.chat_id }, row.sender_id);
    } catch (e) {
      console.error('Ошибка удаления сообщения:', e);
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      onlineUsers.delete(socket.userId);
      io.emit('online_users', Array.from(onlineUsers.keys()));
    }
    console.log(`Отключен: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3010;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));