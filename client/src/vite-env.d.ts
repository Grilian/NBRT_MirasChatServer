/// <reference types="vite/client" />

// Настройки сборки, которые приходят снаружи. Значения задаются в
// scripts/build-client.js у desktop и mobile, а для веба берутся из .env либо
// из запасных значений в коде — поэтому все поля необязательные.
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_SOCKET_URL?: string;
  readonly VITE_SOCKET_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
