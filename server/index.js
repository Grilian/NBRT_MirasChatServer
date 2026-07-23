require('dotenv').config({ quiet: true });
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const verifyToken = require('./middleware/verifyToken');
const userRoutes = require('./routes/users');
const unreadRoutes = require('./routes/unread');
const favoritesRoutes = require('./routes/favorites');
const commentsRoutes = require('./routes/comments');
const superadminRoutes = require('./routes/superadmin');
const contactsRoutes = require('./routes/contacts');
const { participantsForChatId, isParticipant } = require('./services/chatParticipants');

const db = require('./db');

// Группы, кому можно писать даже в режиме тишины — обращение к администрации
// напрямую, а не рассылка (general всё равно остаётся заблокирован).
const MUTE_EXEMPT_GROUPS = ['Администрация', 'Админы'];

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
app.use('/api/contacts', contactsRoutes);

// Раздача загруженных аватаров — просто статика, без отдельной авторизации
// на каждый файл (как публичные CDN-ссылки на фото профиля у большинства
// мессенджеров), доступ к самому приложению уже закрыт логином/паролем.
// Смонтировано под /api/uploads (а не просто /uploads): в проде reverse-proxy
// проксирует на бэкенд только префикс /api — отдельного правила для /uploads
// нет, и файлы отдавались бы SPA-фолбэком (index.html) вместо самой картинки.
app.use('/api/uploads', express.static(path.join(__dirname, 'uploads')));

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

  // Раньше принимали userId прямо от клиента без проверки — любой мог
  // назваться чужим id и получать чужие личные сообщения через комнату
  // 'user:<id>'. Теперь клиент присылает свой JWT, а userId берём из него.
  socket.on('user_online', (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_super_secret_key');
      const userId = decoded.id;
      onlineUsers.set(userId, socket.id);
      socket.userId = userId;
      socket.join('user:' + userId);
      io.emit('online_users', Array.from(onlineUsers.keys()));
    } catch (e) {
      socket.emit('auth_error', { reason: 'invalid_token' });
    }
  });

  socket.on('chat_message', async (data) => {
    // Не доверяем data.senderId — это просто то, что прислал клиент, и его
    // легко подделать. Единственный источник истины — socket.userId,
    // выставленный сервером при аутентифицированном 'user_online'.
    const senderId = socket.userId;
    if (!senderId) return;

    // Пишем только в чат, где отправитель реально участник — раньше это никак
    // не проверялось, и любой мог отправить сообщение в chat_<a>_<b> чужих
    // пользователей, просто зная их id.
    if (!isParticipant(data.chatId, senderId)) return;

    // Режим тишины — проверяем по аутентичному senderId, а не по тому, что
    // прислал клиент. Заодно берём имя — раньше отправленное сообщение
    // вообще не несло имени отправителя, и в общем чате живые сообщения не
    // могли показать, кто написал (клиент брал его из payload, которого не было).
    const senderRow = db.prepare('SELECT username, display_name, muted FROM users WHERE id = ?').get(senderId);
    if (senderRow && senderRow.muted) {
      // Исключение: даже в режиме тишины можно писать конкретным людям из
      // групп "Администрация"/"Админы" — это не про рассылку (general
      // остаётся заблокирован), а про обращение к администрации напрямую.
      let muteExempt = false;
      const participants = participantsForChatId(data.chatId);
      if (participants && participants.length === 2) {
        const otherId = participants.find((pid) => pid !== senderId);
        const otherGroup = db.prepare(
          'SELECT g.name FROM users u LEFT JOIN groups g ON g.id = u.group_id WHERE u.id = ?'
        ).get(otherId);
        muteExempt = !!(otherGroup && MUTE_EXEMPT_GROUPS.includes(otherGroup.name));
      }

      if (!muteExempt) {
        socket.emit('message_blocked', { reason: 'muted', chatId: data.chatId });
        return;
      }
    }

    try {
      // Сохраняем в локальную БД
      const stmt = db.prepare(
        'INSERT INTO messages (chat_id, sender_id, text, status) VALUES (?, ?, ?, ?)'
      );
      const result = stmt.run(data.chatId, senderId, data.text, 'sent');

      const message = {
        id: result.lastInsertRowid,
        chat_id: data.chatId,
        sender_id: senderId,
        text: data.text,
        status: 'sent',
        created_at: new Date().toISOString(),
        username: senderRow ? senderRow.username : undefined,
        display_name: senderRow ? senderRow.display_name : undefined,
      };

      emitToChat(data.chatId, 'chat_message', message, senderId);

      // Автоподписка: как только между двумя людьми реально пошли сообщения,
      // чат появляется в списке контактов у обеих сторон (не только у
      // отправителя, который мог сам явно добавить собеседника из справочника)
      // — иначе получатель первого сообщения просто не увидел бы новый чат.
      const participants = participantsForChatId(data.chatId);
      if (participants && participants.length === 2) {
        const [a, b] = participants;
        const insertContact = db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_user_id) VALUES (?, ?)');
        const changedA = insertContact.run(a, b).changes > 0;
        const changedB = insertContact.run(b, a).changes > 0;
        if (changedA) io.to('user:' + a).emit('contact_added', { withUserId: b });
        if (changedB) io.to('user:' + b).emit('contact_added', { withUserId: a });
      }

      // Проверяем, есть ли получатель онлайн
      let recipientOnline = false;
      if (data.chatId === 'general') {
        recipientOnline = Array.from(onlineUsers.keys()).some(id => id !== senderId);
      } else {
        const match = data.chatId.match(/^chat_(\d+)_(\d+)$/);
        if (match) {
          const otherId = Number(match[1]) === senderId ? Number(match[2]) : Number(match[1]);
          recipientOnline = onlineUsers.has(otherId);
        }
      }

      if (recipientOnline) {
        db.prepare('UPDATE messages SET status = ? WHERE id = ?').run('delivered', result.lastInsertRowid);
        message.status = 'delivered';
        emitToChat(data.chatId, 'message_status', { id: result.lastInsertRowid, status: 'delivered' }, senderId);
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