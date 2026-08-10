import axios from 'axios';

const api = axios.create({
  baseURL: process.env.REACT_APP_API_BASE_URL || 'http://192.168.24.2/MirasChatServer/api',
  // Сервер использует возможности, а не номер версии: старые клиенты не
  // объявляют threads и поэтому не получают непрочитанное из невидимых им веток.
  headers: { 'X-Miras-Features': 'threads,notification-policy' },
  // Без таймаута запрос, начатый прямо перед уходом приложения в фон на
  // Android, может зависнуть на неопределённое время, если ОС обрывает сеть
  // фоновому процессу — тогда ни .then, ни .catch не сработают, и часть UI
  // (например, загрузка сообщений при возврате из фона) останется в подвисшем
  // состоянии до перезапуска приложения.
  timeout: 15000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default api;
