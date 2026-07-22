require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const verifyToken = require('./middleware/verifyToken');
const userRoutes = require('./routes/users');
const unreadRoutes = require('./routes/unread');
const favoritesRoutes = require('./routes/favorites');
const commentsRoutes = require('./routes/comments');
const mirasAdminsRoutes = require('./routes/mirasAdmins');
const mirasUsersRoutes = require('./routes/mirasUsers');
const { ensureLocalUserForAdmin } = require('./services/mirasAdminUsers');
const { parseAdminChatId, participantsForChatId } = require('./services/chatParticipants');

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
app.use('/api/miras-admins', mirasAdminsRoutes);
app.use('/api/miras-users', mirasUsersRoutes);

const server = http.createServer(app);
const io = new Server(server, {
  path: process.env.SOCKET_IO_PATH || '/MirasChatServer/socket.io',
  cors: {
    origin: '*'
  }
});
app.set('io', io);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ===== Настройки интеграции с МИРАС =====
const MIRAS_URL = process.env.MIRAS_URL || 'http://localhost:3000';
const CHAT_SHARED_SECRET = process.env.CHAT_SHARED_SECRET || '';

// Без keep-alive: путь до Мираса идёт через обратный SSH-туннель, который
// периодически переустанавливается (сеть, перезапуск) — переиспользованное
// закешированное соединение может молча "успешно" отвечать, не долетая до
// реального приложения. Для редких, некрупных сообщений чата разумнее каждый
// раз открывать свежее соединение, чем экономить на хендшейке.
const mirasHttpAgent = new (require('http').Agent)({ keepAlive: false });

// ===== Endpoint для приёма сообщений ОТ МИРАС =====
app.post('/api/chat/receive', (req, res) => {
  try {
    const receivedSecret = req.headers['x-nbrt-chat-token'];
    if (receivedSecret !== CHAT_SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const {
        origin,
        sender_key,
        sender_login,
        recipient_key,
        message,
        sent_at
    } = req.body;

    if (
        sender_key &&
        sender_key.startsWith("admin:") &&
        recipient_key !== "__public__"
    ) {
      const adminLogin = sender_key.replace('admin:', '');
      const senderId = ensureLocalUserForAdmin(adminLogin);

      // recipient_key приходит как miras_chat:<username> — нужно найти локального
      // сотрудника, иначе сообщение некуда положить (и его увидели бы все подряд).
      const recipientUsername = String(recipient_key || '').replace('miras_chat:', '');
      const recipientUser = db.prepare('SELECT id FROM users WHERE username = ?').get(recipientUsername);

      if (!recipientUser) {
        console.error('MirasChat: получатель не найден локально:', recipientUsername);
      } else {
        const chatId = `miras_admin_${adminLogin}_${recipientUser.id}`;

        const stmt = db.prepare(`
          INSERT INTO messages (chat_id, sender_id, text, created_at, status)
          VALUES (?, ?, ?, ?, 'delivered')
        `);
        const result = stmt.run(chatId, senderId, message, sent_at || new Date().toISOString());

        // Личное сообщение от админа — уходит только этому сотруднику,
        // а не всем подключённым (иначе содержимое личной переписки увидели бы все).
        io.to('user:' + recipientUser.id).emit('chat_message', {
          id: result.lastInsertRowid,
          chat_id: chatId,
          sender_id: senderId,
          username: sender_login,
          text: message,
          created_at: sent_at || new Date().toISOString(),
          status: 'delivered'
        });
      }
    }

    // Получили сообщение из общего чата МИРАС
    if (recipient_key === "__public__") {

      // Раньше тут была своя схема (miras_<login>), отдельная от
      // ensureLocalUserForAdmin (miras_admin_<login>) — один и тот же админ
      // получал два разных зеркала. Используем общую функцию.
      const senderId = ensureLocalUserForAdmin(sender_login);

      const stmt = db.prepare(`
        INSERT INTO messages (
          chat_id,
          sender_id,
          text,
          created_at,
          status
        )
        VALUES (?, ?, ?, ?, 'delivered')
      `);

      const result = stmt.run(
          "general",
          senderId,
          message,
          sent_at || new Date().toISOString()
      );

      io.emit("chat_message", {
        id: result.lastInsertRowid,
        chat_id: "general",
        sender_id: senderId,
        username: sender_login,
        text: message,
        created_at: sent_at || new Date().toISOString(),
        status: "delivered"
      });
    }

    res.json({ ok: true });

  } catch (e) {
    console.error("CHAT RECEIVE ERROR:", e);
    res.status(500).json({
      ok: false,
      error: e.message,
      stack: e.stack
    });
  }
});

function emitToChat(chatId, event, payload) {
  const participants = participantsForChatId(chatId);
  if (participants === null) {
    io.emit(event, payload);
  } else if (participants.length) {
    io.to(participants.map((id) => 'user:' + id)).emit(event, payload);
  }
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
    if (data.origin === "miras") {
        return;
    }
    try {
      // Общий чат → общий чат МИРАС
      if (data.chatId === "general") {
        try {
          await axios.post(`${MIRAS_URL}/api/chat/receive`, {
            origin: "miras_chat",
            sender_key: `miras_chat:${data.senderUsername}`,
            sender_login: data.senderUsername,
            recipient_key: "__public__",
            message: data.text,
            sent_at: new Date().toISOString()
          }, {
            headers: {
              "Content-Type": "application/json",
              "X-NBRT-Chat-Token": CHAT_SHARED_SECRET
            },
            httpAgent: mirasHttpAgent,
            timeout: 5000
          });
        } catch (e) {
          console.error("Ошибка отправки общего чата в МИРАС:", e.message);
        }
      }
      // Если это чат с админом МИРАС — пересылаем в МИРАС
      if (data.chatId && data.chatId.startsWith('miras_admin_')) {
        const parsedAdminChat = parseAdminChatId(data.chatId);
        const adminLogin = parsedAdminChat ? parsedAdminChat.login : data.chatId.replace('miras_admin_', '');
        try {
          await axios.post(`${MIRAS_URL}/api/chat/receive`, {
            sender_key: `miras_chat:${data.senderUsername}`,
            sender_login: data.senderUsername,
            recipient_key: `admin:${adminLogin}`,
            message: data.text,
            sent_at: new Date().toISOString()
          }, {
            headers: {
              'Content-Type': 'application/json',
              'X-NBRT-Chat-Token': CHAT_SHARED_SECRET
            },
            httpAgent: mirasHttpAgent,
            timeout: 5000
          });
        } catch (e) {
          console.error('Ошибка отправки в МИРАС:', e.message);
        }
      }

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

      emitToChat(data.chatId, 'chat_message', message);

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
        emitToChat(data.chatId, 'message_status', { id: result.lastInsertRowid, status: 'delivered' });
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