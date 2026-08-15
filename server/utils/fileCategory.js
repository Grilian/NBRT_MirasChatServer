// Категория файла для раздела «Файлы» и вкладки вложений.
//
// Общий модуль, а не копия в каждом месте: одна и та же раскладка нужна и в
// личном хранилище, и в карточке переписки, и разъехаться этим двум значило бы
// показывать один файл в разных разделах.
// Деление вкладки «Файлы» на категории. Считает СЕРВЕР, а не клиент: та же
// раскладка нужна и в вебе, и на телефоне, и в десктопе, а расходиться этим
// трём копиям нельзя — человек увидел бы файл то в «Документах», то в
// «Файлах» в зависимости от устройства.
//
// Расширение важнее MIME: MIME приходит от клиента (для показа значка, не для
// доверия), и телефоны регулярно шлют application/octet-stream на всё подряд.
const CATEGORY_EXTENSIONS = {
  documents: ['pdf', 'doc', 'docx', 'rtf', 'odt', 'txt', 'xls', 'xlsx', 'ods', 'csv',
    'ppt', 'pptx', 'odp', 'djvu', 'epub', 'fb2'],
  images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'tif', 'tiff', 'psd'],
  music: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'wma', 'opus', 'mid', 'midi'],
};

function fileCategory(name, mime) {
  const ext = (/\.([a-zA-Z0-9]{1,12})$/.exec(String(name || '')) || [, ''])[1].toLowerCase();
  for (const [category, list] of Object.entries(CATEGORY_EXTENSIONS)) {
    if (list.includes(ext)) return category;
  }
  // Расширения не оказалось (или оно незнакомое) — тогда пусть скажет MIME.
  const type = String(mime || '').toLowerCase();
  if (type.startsWith('image/')) return 'images';
  if (type.startsWith('audio/')) return 'music';
  if (type.startsWith('text/') || type.includes('pdf') || type.includes('word')
    || type.includes('excel') || type.includes('spreadsheet') || type.includes('presentation')) {
    return 'documents';
  }
  // «Файлы» — не свалка «мы не разобрались», а честная категория: архивы,
  // установщики, дампы. Отдельная от документов ровно потому, что искать в
  // ней приходится другое.
  return 'files';
}

module.exports = { fileCategory, CATEGORY_EXTENSIONS };
