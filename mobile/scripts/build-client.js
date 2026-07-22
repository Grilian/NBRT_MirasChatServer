const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const CLIENT_DIR = path.join(__dirname, '..', '..', 'client');
const BUILD_DIR_NAME = 'build-mobile';
const CLIENT_BUILD_DIR = path.join(CLIENT_DIR, BUILD_DIR_NAME);
const WWW_DIR = path.join(__dirname, '..', 'www');

const env = {
  ...process.env,
  PUBLIC_URL: '.',
  BUILD_PATH: BUILD_DIR_NAME,
  GENERATE_SOURCEMAP: 'false',
  REACT_APP_API_BASE_URL: process.env.MIRASCHAT_API_BASE_URL || 'https://cagrizzz.ru/miraschat/api',
  REACT_APP_SOCKET_URL: process.env.MIRASCHAT_SOCKET_URL || 'https://cagrizzz.ru',
  REACT_APP_SOCKET_PATH: process.env.MIRASCHAT_SOCKET_PATH || '/miraschat/socket.io'
};

console.log('Сборка клиента для Android...');
console.log('  API:', env.REACT_APP_API_BASE_URL);
console.log('  Socket:', env.REACT_APP_SOCKET_URL, env.REACT_APP_SOCKET_PATH);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npmCmd, ['run', 'build'], { cwd: CLIENT_DIR, env, stdio: 'inherit', shell: true });

fs.rmSync(WWW_DIR, { recursive: true, force: true });
fs.cpSync(CLIENT_BUILD_DIR, WWW_DIR, { recursive: true });
console.log('Скопировано в', WWW_DIR);
