const fs = require('fs');
const path = require('path');

// Удаляем загруженный файл с диска по пути вида "/uploads/..." — best-effort,
// отсутствие файла не ошибка. Общая для аватаров и картинок в чате: разница
// между ними только в подпапке, сама логика удаления одинаковая.
function deleteUploadedFile(uploadPath) {
  if (!uploadPath) return;
  const abs = path.join(__dirname, '..', uploadPath.replace(/^\//, ''));
  fs.unlink(abs, () => {});
}

module.exports = { deleteAvatarFile: deleteUploadedFile, deleteUploadedFile };
