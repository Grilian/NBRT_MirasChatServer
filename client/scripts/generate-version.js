// Пишет src/version.ts перед каждой сборкой/запуском — короткий git-хэш и
// дата сборки, чтобы после деплоя можно было свериться, какая версия реально
// выложена (см. .settings-row с версией внизу настроек).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function safeExec(cmd) {
  try {
    return execSync(cmd, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

const hash = safeExec('git rev-parse --short HEAD') || 'dev';
const dirty = safeExec('git status --porcelain');
const version = dirty ? `${hash}+` : hash;

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const builtAt = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

const out = `// Автогенерируется scripts/generate-version.js перед build/start — не редактировать вручную.
export const APP_VERSION = ${JSON.stringify(version)};
export const BUILT_AT = ${JSON.stringify(builtAt)};
`;

fs.writeFileSync(path.join(__dirname, '..', 'src', 'version.ts'), out);
console.log(`[version] ${version} (${builtAt})`);
