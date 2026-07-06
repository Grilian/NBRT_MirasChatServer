require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const verifyToken = require('./middleware/verifyToken');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// REST API
app.use('/api/auth', authRoutes);
app.use('/api/messages', verifyToken, messageRoutes); // Защищенный роут

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.set('io', io); 

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// WebSocket
io.on('connection', (socket) => {
  console.log(`Подключен: ${socket.id}`);

  socket.on('chat_message', (data) => {
    try {
      // Сохраняем в БД
      const stmt = db.prepare('INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)');
      const result = stmt.run(data.chatId, data.senderId, data.text);
      
      // Отправляем всем с новыми данными из БД
      io.emit('chat_message', {
        id: result.lastInsertRowid,
        chat_id: data.chatId,
        sender_id: data.senderId,
        text: data.text,
        created_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('Ошибка сохранения:', e);
    }
  });

  socket.on('disconnect', () => console.log(`Отключен: ${socket.id}`));
});

const PORT = process.env.PORT || 3010;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));