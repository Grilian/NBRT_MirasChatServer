// Колонки сообщения, накопленные по ходу: статус, правка, ответ,
// прочтение, картинка, IP отправителя.
//
// Шаг схемы. Порядок шагов задан в ../index.js и значение имеет: более
// поздние опираются на таблицы, заведённые более ранними.
module.exports = (db) => {
  // Миграция: добавляем колонку status, если БД старая
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'sent'`);
  } catch (e) {
    // Колонка уже есть
  }

  // Миграция: редактирование/удаление сообщений
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN edited_at DATETIME`);
  } catch (e) {
    // Колонка уже есть
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0`);
  } catch (e) {
    // Колонка уже есть
  }

  // Миграция: размеры картинки в сообщении. file_path существовал с самого
  // начала, но им никто не пользовался; ширина/высота — чтобы клиент мог
  // отрисовать плейсхолдер под нужный размер до того, как файл загрузится, и
  // не дёргать вёрстку, когда изображение наконец появится.
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN file_width INTEGER`);
  } catch (e) {
    // Колонка уже есть
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN file_height INTEGER`);
  } catch (e) {
    // Колонка уже есть
  }

  // Миграция: IP отправителя. Метаданные о факте передачи сообщения (время,
  // отправитель, получатель, IP) обязаны храниться отдельно от содержимого —
  // удаление сообщения (см. message_delete) стирает text/file_path, но не эту
  // колонку и не саму строку целиком: удалённое сообщение остаётся в базе,
  // просто без содержимого и невидимым в интерфейсе.
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN sender_ip TEXT`);
  } catch (e) {
    // Колонка уже есть
  }

  // Миграция: ответ на сообщение. Без внешнего ключа намеренно — на исходное
  // сообщение можно ответить, а потом его удалят (deleted=1, строка остаётся),
  // и цитата должна пережить это, показав «сообщение удалено» вместо текста.
  // Пересылка отмечается парой forwarded_from_*: имя автора берём снимком, а не
  // join'ом по id, потому что человека могут переименовать или удалить, а в
  // пересланном сообщении должно остаться то, что видел пересылавший.
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN reply_to_id INTEGER`);
  } catch (e) {
    // Колонка уже есть
  }

  // Миграция: когда сообщение прочитали — для пункта «Прочитано в [время]» в
  // меню сообщения. Только для личной переписки: там получатель ровно один и
  // метка однозначна. В общих чатах и группах «кто и когда прочитал» живёт в
  // message_reads по человеку, и одной метки на сообщение там не бывает.
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN read_at INTEGER`);
  } catch (e) {
    // Колонка уже есть
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN forwarded_from_name TEXT`);
  } catch (e) {
    // Колонка уже есть
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN forwarded_from_chat TEXT`);
  } catch (e) {
    // Колонка уже есть
  }

  // Идентификатор назначает клиент до первой попытки отправки и хранит вместе
  // с сообщением в локальной очереди. Если сервер успел записать сообщение, но
  // подтверждение потерялось при обрыве сети, повтор с тем же id должен вернуть
  // уже существующую строку, а не создать дубликат.
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN client_message_id TEXT`);
  } catch (e) {
    // Колонка уже есть
  }
  // Ответ ветки остаётся обычным сообщением со всеми юридически значимыми
  // полями, но не попадает в основную ленту. Корнем всегда является сообщение
  // верхнего уровня; вложенных веток нет.
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN thread_root_id INTEGER`);
  } catch (e) {
    // Колонка уже есть
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN deleted_at INTEGER`);
  } catch (e) {
    // Колонка уже есть
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN deleted_by INTEGER`);
  } catch (e) {
    // Колонка уже есть
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN force_notification INTEGER NOT NULL DEFAULT 0`);
  } catch (e) {
    // Колонка уже есть
  }
  // Уборка 07.09.2026: механизм «возможностей клиента» снят целиком.
  //
  // device_tokens.capabilities существовал ради одного признака — 'threads':
  // сервер не слал пуш о ветке устройству, которое про ветки ещё не знает.
  // Обратная совместимость со старыми клиентами снята, признак есть у всех,
  // и целый механизм (колонка + заголовок X-Miras-Features + фильтр в push.js)
  // остался бы висеть без единого потребителя.
  try {
    db.exec('ALTER TABLE device_tokens DROP COLUMN capabilities');
  } catch (e) {
    // Колонки уже нет
  }

  // organizations и organization_members — заброшенный заход на
  // мультиорганизационность: ни одного упоминания ни в сервере, ни в клиенте
  // при 1 и 28 строках данных на проде. Схема их не создаёт, но на боевой базе
  // они лежат с очень давних пор.
  try {
    db.exec('DROP TABLE IF EXISTS organization_members');
    db.exec('DROP TABLE IF EXISTS organizations');
  } catch (e) {
    // Таблиц уже нет
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sender_client_id
    ON messages(sender_id, client_message_id)
    WHERE client_message_id IS NOT NULL
  `);
};
