const axios = require('axios');
const http = require('http');

const MIRAS_URL = process.env.MIRAS_URL || 'http://localhost:3000';
const CHAT_SECRET = process.env.CHAT_SHARED_SECRET || '';
const MIRAS_TOKEN = process.env.MIRAS_CHAT_TOKEN || '';

// Без keep-alive — путь до Мираса обычно идёт через обратный SSH-туннель,
// который может пересоздаваться (сеть, перезапуск); переиспользованное
// закешированное соединение рискует молча не долетать до реального
// приложения. Трафик редкий и небольшой, свежее соединение дешевле бага.
const mirasHttpAgent = new http.Agent({ keepAlive: false });

// Получить список админов из МИРАС
async function getMirasAdmins() {
  try {
    const response = await axios.get(`${MIRAS_URL}/api/public/admins`, {
      headers: { 'X-Miras-Chat-Token': MIRAS_TOKEN },
      httpAgent: mirasHttpAgent,
      timeout: 5000
    });
    return response.data.admins || [];
  } catch (e) {
    console.error('Ошибка получения админов из МИРАС:', e.message);
    return [];
  }
}

// Отправить сообщение админу МИРАС
async function sendToMirasAdmin(adminLogin, senderUsername, message) {
  try {
    const response = await axios.post(`${MIRAS_URL}/api/chat/receive`, {
      sender_key: `miras_chat:${senderUsername}`,
      sender_login: senderUsername,
      recipient_key: `admin:${adminLogin}`,
      message: message,
      sent_at: new Date().toISOString()
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-NBRT-Chat-Token': CHAT_SECRET
      },
      httpAgent: mirasHttpAgent,
      timeout: 5000
    });
    return response.data;
  } catch (e) {
    console.error('Ошибка отправки в МИРАС:', e.message);
    return null;
  }
}

// Вызывается при удалении аккаунта MirasChat, чтобы его переписка не
// "приклеилась" к новому аккаунту, если кто-то потом заведёт тот же логин.
async function purgeMirasChatUserHistory(username) {
  try {
    await axios.post(`${MIRAS_URL}/api/chat/purge-external-user`, {
      username
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Miras-Chat-Token': MIRAS_TOKEN
      },
      httpAgent: mirasHttpAgent,
      timeout: 5000
    });
    return true;
  } catch (e) {
    console.error('Ошибка очистки истории в МИРАС:', e.message);
    return false;
  }
}

module.exports = {
  getMirasAdmins,
  sendToMirasAdmin,
  purgeMirasChatUserHistory
};