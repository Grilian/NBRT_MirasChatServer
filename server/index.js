require('dotenv').config();
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
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// REST API
app.use('/api/auth', authRoutes);
app.use('/api/messages', verifyToken, messageRoutes); // Защищенный роут
app.use('/api/users', userRoutes);
app.use('/api/unread', unreadRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/comments', commentsRoutes);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.set('io', io); 

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// WebSocket
// Хранение онлайн-пользователей
const onlineUsers = new Map(); // userId -> socketId

io.on('connection', (socket) => {
  console.log(`Подключен: ${socket.id}`);

  socket.on('user_online', (userId) => {
    onlineUsers.set(userId, socket.id);
    socket.userId = userId;
    io.emit('online_users', Array.from(onlineUsers.keys()));
  });

  socket.on('chat_message', (data) => {
    try {
      const stmt = db.prepare('INSERT INTO messages (chat_id, sender_id, text, status) VALUES (?, ?, ?, ?)');
      const result = stmt.run(data.chatId, data.senderId, data.text, 'sent');

      const message = {
        id: result.lastInsertRowid,
        chat_id: data.chatId,
        sender_id: data.senderId,
        text: data.text,
        status: 'sent',
        created_at: new Date().toISOString(),
      };

      // Отправляем сообщение всем
      io.emit('chat_message', message);

      // Проверяем, есть ли получатель онлайн
      // Для личного чата (chat_1_2) — получатель это другой юзер
      // Для общего чата (general) — все онлайн кроме отправителя
      let recipientOnline = false;

      if (data.chatId === 'general') {
        // В общем чате — если есть хоть кто-то онлайн кроме отправителя
        recipientOnline = Array.from(onlineUsers.keys()).some(id => id !== data.senderId);
      } else {
        // Личный чат: находим ID второго участника
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

  // Отметка о прочтении
  socket.on('message_read', ({ chatId, messageIds }) => {
    if (!messageIds || messageIds.length === 0) return;
    
    const placeholders = messageIds.map(() => '?').join(',');
    db.prepare(`UPDATE messages SET status = 'read' WHERE id IN (${placeholders})`).run(...messageIds);
    
    io.emit('message_status_bulk', {
      chatId,
      messageIds,
      status: 'read',
    });
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      onlineUsers.delete(socket.userId);
      io.emit('online_users', Array.from(onlineUsers.keys()));
    }
    console.log(`Отключен: ${socket.id}`);
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
});

const PORT = process.env.PORT || 3010;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));