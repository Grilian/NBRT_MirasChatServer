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
  path: '/MirasChatServer/socket.io',
  cors: {
    origin: '*'
  }
});
app.set('io', io);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ===== Настройки интеграции с МИРАС =====
const MIRAS_URL = process.env.MIRAS_URL || 'http://localhost:3000';
const CHAT_SHARED_SECRET = process.env.CHAT_SHARED_SECRET || '';

// ===== Endpoint для приёма сообщений ОТ МИРАС =====
app.post('/api/chat/receive', (req, res) => {
  try {
    console.log("CHAT RECEIVE:", req.body);
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
      const virtualAdminId = Math.abs(hashCode(adminLogin)) % 10000 + 10000;
      const chatId = `miras_admin_${adminLogin}`;

      const stmt = db.prepare(`
        INSERT INTO messages (chat_id, sender_id, text, created_at, status)
        VALUES (?, ?, ?, ?, 'delivered')
      `);
      const result = stmt.run(chatId, virtualAdminId, message, sent_at || new Date().toISOString());

      io.emit('chat_message', {
        id: result.lastInsertRowid,
        chat_id: chatId,
        sender_id: virtualAdminId,
        username: sender_login,
        text: message,
        created_at: sent_at || new Date().toISOString(),
        status: 'delivered'
      });
    }

    // Получили сообщение из общего чата МИРАС
    if (recipient_key === "__public__") {

      const localUsername = `miras_${sender_key.replace("admin:", "")}`;

      let localAdmin = db.prepare(`
          SELECT id
          FROM users
          WHERE username = ?
      `).get(localUsername);

      if (!localAdmin) {

          const insert = db.prepare(`
              INSERT INTO users (username, password)
              VALUES (?, ?)
          `);

          const result = insert.run(
              localUsername,
              "miras_admin"
          );

          localAdmin = {
              id: result.lastInsertRowid
          };
      }

      const senderId = localAdmin.id;

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

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
}

// ===== WebSocket =====
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log(`Подключен: ${socket.id}`);

  socket.on('user_online', (userId) => {
    onlineUsers.set(userId, socket.id);
    socket.userId = userId;
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
            timeout: 5000
          });
        } catch (e) {
          console.error("Ошибка отправки общего чата в МИРАС:", e.message);
        }
      }
      // Если это чат с админом МИРАС — пересылаем в МИРАС
      if (data.chatId && data.chatId.startsWith('miras_admin_')) {
        const adminLogin = data.chatId.replace('miras_admin_', '');
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

      io.emit('chat_message', message);

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
        io.emit('message_status', { id: result.lastInsertRowid, status: 'delivered' });
      }
    } catch (e) {
      console.error('Ошибка:', e);
    }
  });

  socket.on('typing', (data) => {
    socket.broadcast.emit('typing', {
      chatId: data.chatId,
      userId: data.userId,
      username: data.username
    });
  });

  socket.on('stop_typing', (data) => {
    socket.broadcast.emit('stop_typing', {
      chatId: data.chatId,
      userId: data.userId
    });
  });

  socket.on('message_read', ({ chatId, messageIds }) => {
    if (!messageIds || messageIds.length === 0) return;
    const placeholders = messageIds.map(() => '?').join(',');
    db.prepare(`UPDATE messages SET status = 'read' WHERE id IN (${placeholders})`).run(...messageIds);
    io.emit('message_status_bulk', { chatId, messageIds, status: 'read' });
  });

  socket.on('message_delivered', (messageId) => {
    try {
      const stmt = db.prepare('UPDATE messages SET status = ? WHERE id = ? AND status = ?');
      const result = stmt.run('delivered', messageId, 'sent');
      if (result.changes > 0) {
        io.emit('message_status', { id: messageId, status: 'delivered' });
      }
    } catch (e) {
      console.error('Ошибка обновления статуса:', e);
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