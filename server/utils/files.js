const fs = require('fs');

// Удаляем загруженный файл с диска по пути вида "/uploads/..." — best-effort,
// отсутствие файла не ошибка. Общая для аватаров и картинок в чате: разница
// между ними только в подпапке, сама логика удаления одинаковая.
function deleteUploadedFile(uploadPath) {
  if (!uploadPath) return;
  // Путь берётся из БД, но через ту же проверку, что и всё остальное: выйти
  // за пределы uploads не должно быть возможно ни одному вызову.
  const abs = require('../services/userStorage').absoluteFromPublic(uploadPath);
  if (!abs) return;
  fs.unlink(abs, () => {});
}

module.exports = { deleteAvatarFile: deleteUploadedFile, deleteUploadedFile };
