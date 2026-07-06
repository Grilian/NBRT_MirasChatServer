import axios from 'axios';

const api = axios.create({
  baseURL: 'http://192.168.24.2:3010/MirasChatServer/api',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default api;