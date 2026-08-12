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
      db.prepare('DELETE FROM google_calendar_links WHERE account_id = ?').run(account.id);
      db.prepare('DELETE FROM google_calendar_deletions WHERE account_id = ?').run(account.id);
    }
    // Сдвиг границы импорта назад тоже требует полного прохода: инкрементальная
    // выборка отдаёт изменения, а не «то, что мы решили посмотреть пораньше».
    const widened = syncFrom !== null && account.sync_from !== null && syncFrom < account.sync_from;

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
