# NBRT_MirasChatServer

Монорепозиторий MirasChat: `client` (веб, React), `server` (Node/Express + Socket.io + SQLite), `desktop` (Electron-обёртка клиента под Windows), `mobile` (Capacitor).

## Обновление продакшн-сервера после `git pull`

Продакшн крутится на `cagrizzz.ru` (пользователь `gri`), путь до репозитория — `~/projects/miraschat`. Веб-клиент собирается на самом сервере и раздаётся статикой из `/var/www/miraschat/dist` (владелец `www-data`), бэкенд — процесс `MirasChatServer` в pm2.

### 0. Подтянуть код

```bash
cd ~/projects/miraschat
git pull origin main --ff-only
```

### 1. Клиент (веб) — если менялось что-то в `client/`

```bash
cd ~/projects/miraschat/client
npm install                         # только если менялся package.json/lock
npm run build                       # соберёт в client/build; заодно прописывает
                                     # версию (git-хэш + время сборки) в
                                     # src/version.ts — см. "Настройки" в приложении
sudo rsync -a --delete /home/gri/projects/miraschat/client/build/ /var/www/miraschat/dist/
sudo chown -R www-data:www-data /var/www/miraschat/dist/
```

`rsync`/`chown` разрешены пользователю `gri` без пароля (см. `sudo -l` — правило добавлено в `/etc/sudoers` через `visudo` для именно этих двух команд), так что весь блок можно скопировать одной строкой:

```bash
cd ~/projects/miraschat/client && npm run build && \
  sudo rsync -a --delete /home/gri/projects/miraschat/client/build/ /var/www/miraschat/dist/ && \
  sudo chown -R www-data:www-data /var/www/miraschat/dist/
```

Перезапуск pm2 для чисто клиентских изменений **не нужен** — это статика, отдаёт её nginx.

### 2. Сервер (бэкенд) — если менялось что-то в `server/`

```bash
cd ~/projects/miraschat/server
npm install                         # только если менялся package.json/lock
pm2 restart MirasChatServer
```

Это разорвёт активные сокет-соединения (пользователи увидят кратковременный дисконнект чата), так что без необходимости не перезапускать.

### 3. Проверить, что раскатилось

```bash
pm2 status MirasChatServer
curl -s -o /dev/null -w '%{http_code}\n' https://cagrizzz.ru/miraschat/
```

В приложении: Настройки → внизу списка строка вида `MirasChat <хэш> · <дата сборки>` — по ней видно, точно ли раскатился актуальный коммит. Хэш с `+` на конце означает, что сборка была сделана при незакоммиченных изменениях в рабочей копии на сервере.

## Версионирование

- **Веб-клиент** (`client/`): версию не нужно вручную трогать. `client/scripts/generate-version.js` запускается автоматически перед `npm start`/`npm run build` (хуки `prestart`/`prebuild` в `client/package.json`) и штампует короткий git-хэш + время сборки в `client/src/version.ts` (в `.gitignore`, не коммитится). Именно эта версия видна в UI (см. выше).
- **Десктоп-приложение** (`desktop/`): версия — это поле `"version"` в `desktop/package.json`, её нужно поднимать **вручную** перед каждой сборкой инсталлятора (`npm run dist:win`), она попадает в имя файла (`MirasChat Setup X.Y.Z.exe`) и в метаданные Electron-приложения. Автоматически не меняется — не забывайте бампить перед `dist:win`.

## Быстрый доступ

Алиас `mirachat-prod` в `~/.ssh/config` (только на машине разработки, не на самом сервере) указывает на `gri@cagrizzz.ru` с ключом `~/.ssh/mirachat_deploy` — им пользуется Claude Code для деплоя по запросу «обнови сервер».
