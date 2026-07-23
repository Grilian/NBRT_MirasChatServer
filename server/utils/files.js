const fs = require('fs');
const path = require('path');

// Удаляем файл аватара с диска — best-effort, отсутствие файла не ошибка.
function deleteAvatarFile(avatarPath) {
  if (!avatarPath) return;
  const abs = path.join(__dirname, '..', avatarPath.replace(/^\//, ''));
  fs.unlink(abs, () => {});
}

module.exports = { deleteAvatarFile };
