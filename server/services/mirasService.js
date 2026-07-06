const axios = require('axios');

const MIRAS_URL = process.env.MIRAS_URL || 'http://localhost:3000';
const CHAT_SECRET = process.env.CHAT_SHARED_SECRET || '';
const MIRAS_TOKEN = process.env.MIRAS_CHAT_TOKEN || '';

// Получить список админов из МИРАС
async function getMirasAdmins() {
  try {
    const response = await axios.get(`${MIRAS_URL}/api/public/admins`, {
      headers: { 'X-Miras-Chat-Token': MIRAS_TOKEN },
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
      timeout: 5000
    });
    return response.data;
  } catch (e) {
    console.error('Ошибка отправки в МИРАС:', e.message);
    return null;
  }
}

module.exports = {
  getMirasAdmins,
  sendToMirasAdmin
};