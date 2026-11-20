# Бэкап Mycelia

Назначение уже настроено: `pk-backup:mycelia/restic-v1` (SSH
`pk@77.51.198.164:22126`). Файлы шифрует restic.

For the separate configurable encrypted MongoDB archive/restore CLI, see
[MongoDB backups](BACKUP_MONGO.md). Neither a file snapshot nor a verified
transfer alone proves database recovery.

Реализован **ручной инкрементальный бэкап файлов и конфигурации** через restic
и отдельная команда полного снимка MongoDB на bastion. MongoDB/PITR в
`backupctl` и автоматическое расписание ещё не реализованы.

## Возобновляемый бэкап остановленной MongoDB → bastion

```sh
cd "$HOME/repo/mycelia"
/opt/homebrew/bin/deno run -A scripts/backup-cold-resumable.ts start
```

Команда требует уже остановленную MongoDB. Создаёт отдельную APFS-копию
данных через copy-on-write (без полной записи объёма второй раз), добавляет
конфигурацию, включая `.env`, и передаёт её на bastion через Homebrew rsync 3.
Обрывы SSH повторяются автоматически; недокачанные файлы сохраняются.
После остановки самой команды продолжайте **тот же снимок**, а не `start`:

```sh
/opt/homebrew/bin/deno run -A scripts/backup-cold-resumable.ts resume <run-id>
```

ID выводится при запуске. Локальное состояние —
`.local/backup/cold-resumable/<run-id>/status.json`; копия на сервере —
`/mnt/datadrive/db-backups/<run-id>/snapshot/`. Нельзя удалять или менять
локальный снимок до завершения. Новые записи в исходную БД после создания
APFS-копии потребуют дополнительного локального места.

На bastion автоматически сверяются SHA-256 всех файлов, затем создаётся
**отдельная** копия для восстановления в контейнере без сети и опубликованных
портов. Успех — `restore-status.json` с `state: complete`,
`transferVerified: true`, `restoreVerified: true`. Проверка охватывает
целостность коллекций и наличие аудио; не проверяет интерфейс приложения.
Исходный снимок, старые архивы и результат восстановления сохраняются.

Это копия БД и конфигурации, не внешних оригиналов и не PITR. При аварийной
остановке источника пригодность копии подтверждается только восстановлением.
Передача зашифрована SSH; **файлы на сервере не зашифрованы**, доступ закрыт
правами `700/600`. Требуются тот же проверенный диск bastion, Python 3 и Docker
на сервере. [Ограничения холодного копирования MongoDB](https://www.mongodb.com/docs/manual/core/backups/).

## Старый потоковый дамп MongoDB → bastion

У этого способа нет возобновления: при обрыве нужен новый дамп.

```sh
cd "$HOME/repo/mycelia"
/opt/homebrew/bin/deno run -A scripts/backup-mongo-bastion.ts
```

Команда передаёт `mongodump --archive --gzip --oplog` напрямую на
`faeon:/mnt/datadrive/db-backups/mycelia-<дата>-<uuid>/`, без локального архива.
SSH-алиас должен вести на `Skywinder@100.119.163.116`. Нужны запущенная MongoDB,
Deno 2.9+, Docker CLI, проверенный SSH host key и Python 3 на bastion.
Этот отдельный запуск пока поддерживает только текущую MongoDB без авторизации;
при включении авторизации он остановится, не выводя пароли.

Передача зашифрована SSH, **сам архив не зашифрован**: каталог закрыт (`700`),
файлы `600`. Старые копии не удаляются. До успешного завершения выгрузки и
сверки SHA-256 файл остаётся `.partial`. Готовность подтверждает
`manifest.json` с `state: transfer_verified`; это проверка передачи, **не
проверка восстановления**. Локальный статус каждого запуска находится в
`.local/backup/bastion-mongo/*.json`, отдельно от `backupctl status`.

Это полный снимок БД, включая сохранённое в БД аудио, но не внешние оригиналы,
`.env` или `SECRET_KEY`. Отключённые внешние диски этому запуску не мешают.
Для восстановления на отдельной тестовой MongoDB нужны
`mongorestore --archive=<файл> --gzip --oplogReplay`; не запускайте его против
рабочей базы. [Правила mongodump](https://www.mongodb.com/docs/database-tools/mongodump/).

## Настройка один раз

В обычном Terminal выполните:

```sh
cd "$HOME/repo/mycelia"
bk() { env -u RESTIC_PASSWORD -u RESTIC_REPOSITORY ./scripts/backupctl "$@"; }
bk bootstrap --compose-root "$PWD" --initialize-keychain
```

Введите показанное подтверждение. Функция `bk` действует только в этом терминале
и не меняет настройки оболочки. Она убирает два конфликтующих параметра restic;
пароль берётся из Keychain.

В приложении **Связка ключей / Keychain Access** найдите
`tech.mycelia.backup.restic`, аккаунт `mycelia`. Сохраните пароль в своей
офлайн-копии для восстановления — не в чате и не в репозитории. Только после
сохранения подтвердите это; `offline-kit-1` — название записи, не пароль:

```sh
bk bootstrap --compose-root "$PWD" --attest-recovery --receipt-id offline-kit-1
```

Затем создайте зашифрованное хранилище:

```sh
bk bootstrap --compose-root "$PWD" --initialize-repository
```

Запускайте шаги по очереди, продолжая только после успеха предыдущего. Скрипт
сам проверяет доступ, источники и хранилище. При ошибке смотрите раздел ниже;
вручную создавать репозиторий или удалять его содержимое не нужно.

## Сделать бэкап

В том же терминале:

```sh
bk files --compose-root "$PWD"
bk status --compose-root "$PWD"
```

Первый запуск сохраняет файлы, следующие передают изменившиеся данные. Успех:
`files.state = "complete"` и новый `files.accepted.snapshotId` в статусе. Старый
`accepted` после неудачного запуска не означает свежий бэкап. В новом терминале
сначала повторите `cd` и определение `bk` выше.

Диски **TM_data и Sky4Tb опциональны**: когда они отключены, их оригиналы не
сохраняются; когда подключены — включаются автоматически. Пропуски видны в
`sourceCounts.skipped` и `sourceCounts.omittedRoots`. Настройка —
`BACKUP_OPTIONAL_SOURCE_ROOTS_JSON` в локальном `.env.backup`. Это не разрешение
пропускать любые другие отсутствующие файлы.

## Если не запускается

- **`CONFIG_INVALID`**: используйте `bk` вместо прямого запуска, чтобы убрать
  унаследованные `RESTIC_PASSWORD` и `RESTIC_REPOSITORY`. Если ошибка
  сохраняется, нужно проверить конфигурацию и права; не выводите пароли.
- **`unexpected EOF` / SSH error**: не работает транспорт до сервера. Сначала
  восстановите SSH/SFTP; эта ошибка не означает потерю бэкапа.
- **`KEYCHAIN_PROVENANCE_MISMATCH`**: не удалось подтвердить helper или запись
  Keychain. Не удаляйте ключи и состояние; требуется разбор незавершённой
  подготовки. Исправленный bootstrap допускает повтор после обычной ошибки
  подготовки, не заменяя существующий ключ.
- **`SOURCE_COVERAGE_INCOMPLETE`**: недоступны обязательные файлы или пути из
  базы. Восстановите доступ либо явно согласуйте исключения. Два опциональных
  диска сами по себе не должны блокировать запуск.
- **`OPLOG_WINDOW_SHORT`**: текущий общий preflight требует минимум час истории
  MongoDB, даже для файлового запуска. Это ограничение реализации, а не ошибка
  удалённого диска.
- **`LOCK_HELD` / `REPOSITORY_QUARANTINED`**: сохраните состояние и разберите
  незавершённый запуск. Не удаляйте lock/quarantine вручную.

Одна диагностическая команда, если нужна:

```sh
bk preflight --compose-root "$PWD" --remote-mode full --json
```

Для разработки:
[архитектура и ограничения](superpowers/specs/2026-09-30-mycelia-incremental-backup-design.md)
и
[план реализации и тесты](superpowers/plans/2026-09-30-mycelia-backup-foundation.md).
