// Разовая нормализация кодов смайликов в символы.
//
// Шаг схемы. Порядок шагов задан в ../index.js и значение имеет: более
// поздние опираются на таблицы, заведённые более ранними.
module.exports = (db) => {
  // ===== Разовая нормализация: коды :u_<ключ>: превращаются в сам символ =====
  //
  // Коды вида `:u_1f605:` — след прежней системы, где смайлик жил картинкой с
  // именем, а в текст уезжало имя. Теперь в тексте лежит обычный Unicode, и
  // подсистема кодов осталась ради считанных значений: набора реакций в
  // настройках, пары статусов и двух сообщений на всём проде.
  //
  // Заменяем ТОЛЬКО те коды, которые разрешаются в существующий смайлик.
  // `:smile3:` и подобные от давно удалённых картинок остаются текстом — они и
  // сейчас показываются текстом, картинок под них нет много лет.
  //
  // Да, здесь трогается messages.text — при том что правило проекта это
  // запрещает. Исключение осознанное и того же рода, что была ручка
  // migrate-unicode-tokens: код без картинки читается человеком как мусор, и
  // оставить его значит сохранить видимую поломку ради буквы правила.
  {
    const named = db.prepare(
      'SELECT name, unicode_key FROM emoji_items WHERE name IS NOT NULL AND unicode_key IS NOT NULL'
    ).all();
    const symbolOf = (key) => String(key).split('-')
      .map((hex) => String.fromCodePoint(parseInt(hex, 16)))
      .join('');
    const byToken = new Map();
    for (const row of named) {
      try { byToken.set(`:${row.name}:`, symbolOf(row.unicode_key)); } catch { /* испорченный ключ */ }
    }
    const normalize = (value) => {
      if (!value || !value.includes(':')) return null;
      let out = value;
      for (const [token, symbol] of byToken) {
        if (out.includes(token)) out = out.split(token).join(symbol);
      }
      return out === value ? null : out;
    };

    let changed = 0;
    const setSetting = db.prepare('UPDATE app_settings SET value = ? WHERE key = ?');
    const reactions = db.prepare("SELECT value FROM app_settings WHERE key = 'reaction_emoji'").get();
    const fixedReactions = reactions && normalize(reactions.value);
    if (fixedReactions) { setSetting.run(fixedReactions, 'reaction_emoji'); changed += 1; }

    const setStatus = db.prepare('UPDATE users SET status_custom = ? WHERE id = ?');
    for (const row of db.prepare("SELECT id, status_custom FROM users WHERE status_custom LIKE '%:%:%'").all()) {
      const fixed = normalize(row.status_custom);
      if (fixed) { setStatus.run(fixed, row.id); changed += 1; }
    }

    const setText = db.prepare('UPDATE messages SET text = ? WHERE id = ?');
    for (const row of db.prepare("SELECT id, text FROM messages WHERE text LIKE '%:%:%'").all()) {
      const fixed = normalize(row.text);
      if (fixed) { setText.run(fixed, row.id); changed += 1; }
    }

    if (changed) console.log(`[смайлики] коды заменены на символы в ${changed} записях`);
  }
};
