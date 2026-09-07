const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const CLIENT_DIR = path.join(__dirname, '..', '..', 'client');
const BUILD_DIR_NAME = 'build-mobile';
const CLIENT_BUILD_DIR = path.join(CLIENT_DIR, BUILD_DIR_NAME);
const WWW_DIR = path.join(__dirname, '..', 'www');

const env = {
  ...process.env,
  // BUILD_PATH читает vite.config.ts: сборка уходит в свой каталог, чтобы не
  // затирать веб-сборку, из которой идёт выкладка. PUBLIC_URL и
  // GENERATE_SOURCEMAP были нужны CRA — у Vite это base и build.sourcemap,
  // и то и другое задано в конфиге.
  BUILD_PATH: BUILD_DIR_NAME,
  VITE_API_BASE_URL: process.env.MIRASCHAT_API_BASE_URL || 'https://cagrizzz.ru/miraschat/api',
  VITE_SOCKET_URL: process.env.MIRASCHAT_SOCKET_URL || 'https://cagrizzz.ru',
  VITE_SOCKET_PATH: process.env.MIRASCHAT_SOCKET_PATH || '/miraschat/socket.io'
};

console.log('Сборка клиента для Android...');
console.log('  API:', env.VITE_API_BASE_URL);
console.log('  Socket:', env.VITE_SOCKET_URL, env.VITE_SOCKET_PATH);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npmCmd, ['run', 'build'], { cwd: CLIENT_DIR, env, stdio: 'inherit', shell: true });

fs.rmSync(WWW_DIR, { recursive: true, force: true });
fs.cpSync(CLIENT_BUILD_DIR, WWW_DIR, { recursive: true });
console.log('Скопировано в', WWW_DIR);
