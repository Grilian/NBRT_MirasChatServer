import { resolveUploadUrl } from './uploads';

// Свои обои под лентой сообщений.
//
// Применяются переменными CSS на корне документа, а не пропсом: лента рисуется
// не в одном месте (переписка, ветка, узкий экран), и прокидывать фон в каждое
// значило бы забыть в половине — та же причина, по которой модульным сделан
// флаг анимации смайликов. Заодно смена фона не требует ни перерисовки React,
// ни перезагрузки: правится одна переменная, и все ленты меняются разом.
//
// Значения по умолчанию живут в самом CSS (узор в .conv-body), поэтому снятие
// обоев — это просто удаление переменных, а не подстановка «пустой» картинки.

const VARS = {
  image: '--chat-wallpaper-image',
  size: '--chat-wallpaper-size',
  position: '--chat-wallpaper-position',
  repeat: '--chat-wallpaper-repeat',
  attachment: '--chat-wallpaper-attachment',
};

export function applyChatWallpaper(path?: string | null): void {
  const root = document.documentElement;
  const url = resolveUploadUrl(path);

  if (!url) {
    for (const name of Object.values(VARS)) root.style.removeProperty(name);
    return;
  }

  // Кавычки обязательны: в имени файла может оказаться символ, который иначе
  // оборвёт значение url() и потушит фон целиком.
  root.style.setProperty(VARS.image, `url("${url}")`);
  // cover, а не contain: обои обязаны закрыть всю ленту, поля по бокам от
  // вертикального снимка выглядели бы обрезанной картинкой, а не фоном.
  root.style.setProperty(VARS.size, 'cover');
  root.style.setProperty(VARS.position, 'center');
  root.style.setProperty(VARS.repeat, 'no-repeat');
  // Узор по умолчанию едет вместе с сообщениями (local), а снимок обязан
  // стоять на месте: уезжающая при прокрутке фотография читается как ошибка.
  root.style.setProperty(VARS.attachment, 'scroll');
}
