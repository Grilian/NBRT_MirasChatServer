import axios from 'axios';

// Отдельный инстанс и отдельный ключ токена в localStorage — панель супер-админа
// это другая учётная система, не должна путаться/конфликтовать с обычной
// сессией сотрудника/МИРАС-логина в том же браузере.
const superAdminApi = axios.create({
  baseURL: process.env.REACT_APP_API_BASE_URL || 'http://192.168.24.2/MirasChatServer/api',
});

superAdminApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('superadmin_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Не допускаем условный GET с ответом 304: для Axios это не успешный ответ,
  // поэтому один закэшированный справочник срывал загрузку всей панели.
  if (config.method?.toLowerCase() === 'get') {
    config.headers['Cache-Control'] = 'no-cache';
    config.headers.Pragma = 'no-cache';
    config.params = { ...config.params, _ts: Date.now() };
  }
  return config;
});

export default superAdminApi;
