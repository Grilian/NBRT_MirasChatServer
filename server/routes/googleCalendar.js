const express = require('express');
const db = require('../db');
const verifySuperAdmin = require('../middleware/verifySuperAdmin');
const oauth = require('../services/googleOAuth');
const api = require('../services/googleCalendarApi');
const sync = require('../services/googleCalendarSync');

const router = express.Router();

// Подключение гугл-аккаунта организации и настройки синхронизации.
//
// Всё, кроме адреса возврата, закрыто супер-админом: подключённый аккаунт — это
// доступ к чужому календарю, и раздавать его правку обычным администраторам
// нельзя. Адрес возврата открыт по необходимости — на него Google приводит
// браузер, и никаких наших заголовков там нет (см. state в googleOAuth.js).

// ===== Настройки приложения =====

router.get('/admin/status', verifySuperAdmin, (req, res) => {
  try {
    const config = oauth.getClientConfig();
    const account = oauth.getAccount();

    res.json({
      client_id: config.clientId || '',
      redirect_uri: config.redirectUri || '',
      // Сам секрет наружу не отдаём никогда — только признак того, что он задан.
      has_secret: !!config.clientSecret,
      configured: oauth.isConfigured(),
      scopes: oauth.SCOPES,
      connected: !!account,
      email: account ? account.google_email : null,
      calendar_id: account ? account.calendar_id : null,
      calendar_name: account ? account.calendar_name : null,
      owner_user_id: account ? account.owner_user_id : null,
      sync_from: account ? account.sync_from : null,
      last_sync_at: account ? account.last_sync_at : null,
      last_error: account ? account.last_error : null,
      // Сколько событий уже связано — самый понятный признак того, что
      // синхронизация действительно работает, а не просто «без ошибок».
      // Дополнительные календари — те же строки источников, только не основной.
      // Отдаём вместе со счётчиком событий: «подключил, а приехало ли» — первый
      // вопрос, на который человек ищет ответ в панели.
      sources: account
        ? db.prepare(`
          SELECT s.id, s.google_calendar_id, s.name, s.color, s.access_role,
                 s.read_only, s.is_main, s.last_error,
                 (SELECT COUNT(*) FROM google_calendar_links l
                   WHERE l.google_calendar_id = s.google_calendar_id) AS linked_count
          FROM google_calendar_sources s
          WHERE s.account_id = ? ORDER BY s.is_main DESC, s.id
        `).all(account.id)
        : [],
      linked_count: account
        ? db.prepare('SELECT COUNT(*) AS c FROM google_calendar_links WHERE account_id = ?')
          .get(account.id).c
        : 0,
      readonly_count: account
        ? db.prepare(
          'SELECT COUNT(*) AS c FROM google_calendar_links WHERE account_id = ? AND push_blocked = 1'
        ).get(account.id).c
        : 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/admin/config', verifySuperAdmin, (req, res) => {
  try {
    const redirectUri = req.body.redirect_uri === undefined
      ? undefined
      : String(req.body.redirect_uri || '').trim();

    // Адрес возврата должен совпасть с записанным в консоли Google до символа,
    // поэтому проверяем его форму здесь: опечатку тут иначе видно только по
    // невнятному redirect_uri_mismatch уже в окне согласия.
    if (redirectUri) {
      let parsed;
      try {
        parsed = new URL(redirectUri);
      } catch {
        return res.status(400).json({ error: 'Адрес возврата — это полный URL' });
      }
      const localhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (parsed.protocol !== 'https:' && !localhost) {
        return res.status(400).json({ error: 'Google принимает только https (кроме localhost)' });
      }
    }

    oauth.saveClientConfig({
      clientId: req.body.client_id,
      // Пустая строка от формы значит «не меняли»: секрет наружу не отдаётся и
      // приезжает обратно пустым. Стирание — только явным null.
      clientSecret: req.body.client_secret === undefined ? undefined : req.body.client_secret,
      redirectUri,
    });

    res.json({ ok: true, configured: oauth.isConfigured() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Подключение аккаунта =====

router.get('/admin/auth-url', verifySuperAdmin, (req, res) => {
  try {
    if (!oauth.isConfigured()) {
      return res.status(400).json({ error: 'Сначала заполните client_id, секрет и адрес возврата' });
    }
    res.json({ url: oauth.buildAuthUrl(oauth.issueState(req.superAdminId)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Адрес возврата Google.
 *
 * Без verifySuperAdmin намеренно: сюда браузер приводит сам Google, и токена
 * панели в запросе нет. Единственное доказательство того, что код авторизации
 * запросили из панели, — одноразовый state.
 */
router.get('/callback', async (req, res) => {
  const finish = (title, message) => {
    res.set('Content-Type', 'text/html; charset=utf-8').send(page(title, message));
  };

  try {
    if (req.query.error) {
      return finish('Не подключено', `Google отказал: ${req.query.error}`);
    }

    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!code || !oauth.consumeState(state)) {
      return finish('Не подключено', 'Ссылка устарела или открыта не из панели. Начните заново.');
    }

    const tokens = await oauth.exchangeCode(code);
    if (!tokens.refresh_token && !oauth.getAccount()) {
      return finish(
        'Не подключено',
        'Google не выдал refresh_token. Отзовите доступ приложению в настройках аккаунта Google и подключите заново.'
      );
    }

    const email = await oauth.fetchEmail(tokens.access_token);
    oauth.saveAccount(tokens, email);
    finish('Аккаунт подключён', `${email || 'Аккаунт Google'} — вернитесь в панель и выберите календарь.`);
  } catch (e) {
    finish('Не подключено', e.response?.data?.error_description || e.message || 'Неизвестная ошибка');
  }
});

router.get('/admin/calendars', verifySuperAdmin, async (req, res) => {
  try {
    const account = oauth.getAccount();
    if (!account) return res.status(400).json({ error: 'Аккаунт не подключён' });
    res.json(await api.listCalendars(account));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.put('/admin/settings', verifySuperAdmin, (req, res) => {
  try {
    const account = oauth.getAccount();
    if (!account) return res.status(400).json({ error: 'Аккаунт не подключён' });

    const calendarId = req.body.calendar_id === undefined
      ? account.calendar_id
      : String(req.body.calendar_id || '').trim() || null;

    const ownerUserId = req.body.owner_user_id === undefined
      ? account.owner_user_id
      : Number(req.body.owner_user_id) || null;

    // owner_id события ссылается на users и пустым быть не может, а супер-админ
    // панели — отдельная сущность и в users его нет. Поэтому проверяем, что
    // выбран настоящий человек: иначе первый же импорт упал бы на внешнем ключе.
    if (ownerUserId !== null && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(ownerUserId)) {
      return res.status(400).json({ error: 'Такого пользователя нет' });
    }

    const syncFrom = req.body.sync_from === undefined
      ? account.sync_from
      : (Number(req.body.sync_from) || null);

    // Смена календаря делает прежний курсор и все привязки бессмысленными:
    // они указывают на события другого календаря, и следующий проход стал бы
    // править чужие строки по чужим id.
    const calendarChanged = calendarId !== account.calendar_id;
    if (calendarChanged) {
      const old = db.prepare(
        'SELECT google_calendar_id FROM google_calendar_sources WHERE account_id = ? AND is_main = 1'
      ).get(account.id);
      if (old) {
        db.prepare('DELETE FROM google_calendar_links WHERE google_calendar_id = ?')
          .run(old.google_calendar_id);
        db.prepare('DELETE FROM google_calendar_deletions WHERE google_calendar_id = ?')
          .run(old.google_calendar_id);
        db.prepare('DELETE FROM google_calendar_sources WHERE account_id = ? AND is_main = 1')
          .run(account.id);
      }
      if (calendarId) {
        // Уже подключённый дополнительным становится основным, а не заводится
        // вторым: пара (аккаунт, календарь) уникальна, и вставка упала бы.
        const existing = db.prepare(
          'SELECT id FROM google_calendar_sources WHERE account_id = ? AND google_calendar_id = ?'
        ).get(account.id, calendarId);
        if (existing) {
          db.prepare('UPDATE google_calendar_sources SET is_main = 1, sync_token = NULL WHERE id = ?')
            .run(existing.id);
        } else {
          db.prepare(`
            INSERT INTO google_calendar_sources
              (account_id, google_calendar_id, name, is_main, read_only, created_at)
            VALUES (?, ?, ?, 1, 1, ?)
          `).run(account.id, calendarId, req.body.calendar_name || calendarId, Date.now());
        }
      }
    }
    // Сдвиг границы импорта назад тоже требует полного прохода: инкрементальная
    // выборка отдаёт изменения, а не «то, что мы решили посмотреть пораньше».
    const widened = syncFrom !== null && account.sync_from !== null && syncFrom < account.sync_from;
    if (widened) {
      // Граница общая на все календари, поэтому и курсоры сбрасываются у всех:
      // оставив хоть один, мы попросили бы у Google «изменения с прошлого раза»
      // там, где нужен полный проход по расширенному промежутку.
      db.prepare('UPDATE google_calendar_sources SET sync_token = NULL WHERE account_id = ?')
        .run(account.id);
    }

    db.prepare(`
      UPDATE google_calendar_accounts
      SET calendar_id = ?, calendar_name = ?, owner_user_id = ?, sync_from = ?,
          sync_token = CASE WHEN ? = 1 THEN NULL ELSE sync_token END,
          last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      calendarId,
      req.body.calendar_name === undefined
        ? account.calendar_name
        : String(req.body.calendar_name || '').slice(0, 200) || null,
      ownerUserId, syncFrom,
      calendarChanged || widened ? 1 : 0,
      Date.now(), account.id
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Цвета слоя дополнительного календаря — те же, что у событий: палитра одна на
// весь календарь, заводить вторую ради этого списка незачем.
const LAYER_COLORS = new Set(['blue', 'green', 'red', 'orange', 'violet', 'teal', 'graphite']);

/**
 * Подключить дополнительный календарь — тот, что показывается отдельным слоем.
 *
 * Право записи не требуется и не проверяется: дополнительные читаются, и самый
 * частый случай — как раз чужой публичный календарь, подписанный аккаунтом.
 */
router.post('/admin/sources', verifySuperAdmin, (req, res) => {
  try {
    const account = oauth.getAccount();
    if (!account) return res.status(400).json({ error: 'Аккаунт не подключён' });

    const calendarId = String(req.body.calendar_id || '').trim();
    if (!calendarId) return res.status(400).json({ error: 'Не выбран календарь' });
    if (calendarId === account.calendar_id) {
      return res.status(400).json({ error: 'Этот календарь уже подключён основным' });
    }

    const exists = db.prepare(
      'SELECT 1 FROM google_calendar_sources WHERE account_id = ? AND google_calendar_id = ?'
    ).get(account.id, calendarId);
    if (exists) return res.status(409).json({ error: 'Этот календарь уже подключён' });

    const color = LAYER_COLORS.has(req.body.color) ? req.body.color : 'violet';

    // read_only = 1 до первого прохода намеренно: права спросит сама
    // синхронизация. Предположить обратное значило бы разрешить отправку в
    // календарь, о котором мы ещё ничего не знаем.
    db.prepare(`
      INSERT INTO google_calendar_sources
        (account_id, google_calendar_id, name, color, read_only, is_main, created_at)
      VALUES (?, ?, ?, ?, 1, 0, ?)
    `).run(
      account.id, calendarId,
      String(req.body.name || calendarId).slice(0, 200),
      color, Date.now()
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Отключить дополнительный календарь.
 *
 * Его события удаляются вместе с ним: они были зеркалом, править их в чате
 * нельзя, и оставшись без источника они превратились бы в мусор, который никто
 * уже не сможет ни обновить, ни убрать. Основной так отключить нельзя — для
 * него это выбор календаря в настройках выше.
 */
router.delete('/admin/sources/:id', verifySuperAdmin, (req, res) => {
  try {
    const source = db.prepare(
      'SELECT * FROM google_calendar_sources WHERE id = ? AND is_main = 0'
    ).get(Number(req.params.id));
    if (!source) return res.status(404).json({ error: 'Календарь не найден' });

    const events = db.prepare(
      'SELECT id FROM calendar_events WHERE scope_kind = ? AND scope_id = ?'
    ).all('gcal', source.id);

    const drop = db.transaction(() => {
      for (const event of events) {
        db.prepare('DELETE FROM calendar_task_completions WHERE event_id = ?').run(event.id);
        db.prepare('DELETE FROM calendar_event_guests WHERE event_id = ?').run(event.id);
        db.prepare('DELETE FROM calendar_event_reminders WHERE event_id = ?').run(event.id);
        db.prepare('DELETE FROM calendar_reminders_sent WHERE event_id = ?').run(event.id);
        db.prepare('DELETE FROM calendar_event_exceptions WHERE event_id = ?').run(event.id);
        // Привязка уйдёт по каскаду вместе с событием.
        db.prepare('DELETE FROM calendar_events WHERE id = ?').run(event.id);
      }
      db.prepare('DELETE FROM google_calendar_deletions WHERE google_calendar_id = ?')
        .run(source.google_calendar_id);
      db.prepare('DELETE FROM google_calendar_sources WHERE id = ?').run(source.id);
    });
    drop();

    const io = req.app.get('io');
    if (io) io.emit('calendar_changed');

    res.json({ ok: true, removed_events: events.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/sync', verifySuperAdmin, async (req, res) => {
  try {
    const result = await sync.runSync(req.app.get('io'));
    if (result.error) return res.status(502).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/admin/connection', verifySuperAdmin, (req, res) => {
  try {
    oauth.disconnect();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Страница возврата рисуется здесь, а не в клиенте: сюда попадают из окна,
// открытого поверх панели, и грузить ради одной строки текста всё приложение
// незачем. Стили — свои, потому что окно ничего о теме панели не знает.
//
// Экранирование делает сама page(), а не вызывающий: в сообщение попадают и
// строки от Google, и текст ошибок, а «не забыть экранировать на каждом из
// пяти вызовов» — это ровно тот уговор, который однажды нарушат.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function page(title, message) {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background:#f5f6f8; color:#1f2328; }
  .card { max-width:420px; padding:28px 32px; background:#fff; border-radius:14px;
          box-shadow:0 8px 30px rgba(0,0,0,.08); text-align:center; }
  h1 { margin:0 0 10px; font-size:19px; }
  p { margin:0 0 18px; font-size:14px; line-height:1.5; color:#5a6069; }
  button { border:0; border-radius:8px; padding:9px 18px; font-size:14px;
           background:#2f6fed; color:#fff; cursor:pointer; }
</style></head>
<body><div class="card">
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <button type="button" onclick="window.close()">Закрыть окно</button>
</div></body></html>`;
}

module.exports = router;
