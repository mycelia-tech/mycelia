# RAG в Mycelia: UI и проверка реализации

Практическое руководство для текущего Stage 1: отдельный сервис `mycelia-rag`,
Qdrant, локальные MiniLM + BM25, без reranker. MongoDB остаётся канонической
базой, а Qdrant — перестраиваемой поисковой проекцией.

Архитектура, lifecycle и полный API-контракт описаны отдельно в
[RAG_QDRANT.md](RAG_QDRANT.md) и [README RAG-сервиса](../rag/README.md).

> Важно: экраны поиска и инспекции показывают фрагменты личных данных. Не
> публикуйте скриншоты, ответы API и логи без предварительной редактуры.

## 1. Где появились новые функции

Открывайте Mycelia через основной nginx:

| Функция                         | Где в UI                       | Прямой URL                                  |
| ------------------------------- | ------------------------------ | ------------------------------------------- |
| Гибридный и векторный поиск     | Левое меню **Search**          | `https://localhost:4433/search`             |
| Состояние и управление индексом | **Settings → Knowledge / RAG** | `https://localhost:4433/settings/knowledge` |
| RAG в чате                      | **Chat → Tools**               | `https://localhost:4433/chat`               |
| Точный HTTP-контракт RAG        | Swagger UI                     | `http://127.0.0.1:48091/docs`               |
| Низкоуровневое состояние Qdrant | Qdrant dashboard               | `http://127.0.0.1:46333/dashboard`          |

Для обычной работы используйте Search и Knowledge. Браузер не должен ходить в
Qdrant напрямую: UI вызывает авторизованный backend resource, а backend —
отдельный RAG API.

### Где RAG пока нет

На странице **Jobs** отдельной RAG-задачи в Stage 1 нет. Источником истины для
операций является SQLite lifecycle внутри RAG-сервиса, а прогресс показывается
на странице Knowledge. Одновременная запись той же операции в BullMQ создала бы
два конкурирующих состояния.

Будущий Jobs-wrapper должен присоединяться к существующему `operationId`, а не
запускать второй rebuild. Он должен показывать progress bar, executor и
раздельные состояния process alive / projection ready / inference ready.

## 2. Как запустить обсчёт основной MongoDB

### Не перепутать full-data и synthetic stack

Для основной базы используется Compose project `mycelia-rag-full`:

| Назначение       | RAG API | Qdrant REST/dashboard | Qdrant gRPC |
| ---------------- | ------: | --------------------: | ----------: |
| Основная MongoDB | `48091` |               `46333` |     `46334` |
| Synthetic tests  | `48191` |               `46433` |     `46434` |

Коллекции с `synthetic` в имени и dashboard на `46433` относятся к тестовым
данным. Основную проекцию смотрите на
`http://127.0.0.1:46333/dashboard#/collections` или через Knowledge UI.

### Текущее состояние

На проверенной локальной установке полный обсчёт уже выполнен. Full-data RAG
подключён к `mycelia` на основном MongoDB host port `27017`, активная проекция
находится в состоянии `ready`. Не запускайте новый rebuild только ради того,
чтобы увидеть данные в Qdrant: сначала откройте правильный dashboard на `46333`
и сравните status с [reference snapshot](#7-проверенный-reference-snapshot).

Текущий live stack был запущен с runtime Compose-настройками. В основном
checkout пока нет постоянного `.env.rag.local`, а в основной `.env` не записан
`RAG_URL`. Контейнеры продолжают работать и переживут обычный restart, но перед
будущим `docker compose up --force-recreate` закрепите настройки по шагам ниже.
Иначе новый backend потеряет RAG-подключение, хотя Qdrant volume сохранится.

Для обычных новых или изменённых записей полный rebuild не нужен. Change stream
обновляет проекцию инкрементально, а **Reconcile** проверяет и исправляет drift.

### Первичный запуск отдельного full-data stack

Команды выполняются из корня основного checkout Mycelia. Они нужны для новой
установки или восстановления отсутствующего RAG stack. Если контейнеры
`mycelia-rag-full-*` уже имеют состояние `Up`, не выполняйте `up --build`
повторно без причины — переходите к проверке status.

1. Убедитесь, что основная MongoDB запущена и healthy:

   ```bash
   docker ps \
     --filter name=mycelia-mongo-1 \
     --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
   ```

2. Создайте локальный ignored-конфиг, не перезаписывая существующий:

   ```bash
   cd ~/repo/mycelia
   test -f .env.rag.local || cp .env.rag.example .env.rag.local
   ```

3. Проверьте в `.env.rag.local` основные значения:

   ```dotenv
   RAG_COMPOSE_PROJECT_NAME=mycelia-rag-full
   RAG_API_BIND=127.0.0.1
   RAG_API_PORT=48091
   RAG_QDRANT_BIND=127.0.0.1
   RAG_QDRANT_HTTP_PORT=46333
   RAG_QDRANT_GRPC_PORT=46334
   RAG_MONGO_URL=mongodb://host.docker.internal:27017/?directConnection=true
   RAG_MONGO_DATABASE=mycelia
   RAG_AUTH_MODE=none
   RAG_REQUIRE_READONLY_MONGO=false
   ```

   `auth none` допустим только при loopback bind. Если API публикуется за
   пределы машины, сначала включите `internal_token`. После отдельной миграции
   основной Mongo URI должен использовать dedicated read-only user, а
   `RAG_REQUIRE_READONLY_MONGO` — значение `true`.

4. Для первичного запуска соберите и поднимите только RAG + Qdrant:

   ```bash
   docker compose \
     -p mycelia-rag-full \
     --env-file .env.rag.local \
     -f docker-compose.rag.yml \
     up -d --build
   ```

   Эта команда не должна пересоздавать основной MongoDB, Redis, backend,
   frontend или nginx.

5. Проверьте process и dependencies до запуска rebuild:

   ```bash
   docker ps \
     --filter label=com.docker.compose.project=mycelia-rag-full \
     --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

   curl -fsS http://127.0.0.1:48091/health
   curl -fsS http://127.0.0.1:46333/readyz
   curl -fsS http://127.0.0.1:48091/v1/status | jq '{
     state,
     activeProjectionId,
     operation: (.operation | {type, state}),
     progress: (.progress | {
       phase, processedSources, totalSources, failedSources
     })
   }'
   ```

   Если `operation.state` равен `running`, не запускайте вторую операцию.

### Когда нажимать Reconcile, а когда Rebuild

Используйте **Settings → Knowledge / RAG**:

- нажмите **Reconcile**, если модель, chunking и schema не менялись, но нужно
  подтянуть обычные insert/update/delete или проверить полноту;
- нажмите **Rebuild projection**, если активной проекции ещё нет, изменился
  embedding profile/model revision/dimensions/normalization, chunking или source
  schema, либо требуется сознательный полный пересчёт;
- не запускайте повторный Rebuild, пока текущая операция `running`;
- при свободном диске менее 8 GiB сначала нажмите **Pause updates** и проведите
  диагностику, ничего не удаляя.

Для первого полного обсчёта:

1. Откройте `https://localhost:4433/settings/knowledge`.
2. Убедитесь, что нет running operation и Qdrant доступен.
3. Нажмите **Rebuild projection** и подтвердите действие.
4. Следите за Candidate projection, фазами `building` → `catching_up`, progress
   bar и per-source counts.
5. Не закрывайте и не удаляйте предыдущую active collection. Blue/green rebuild
   переключит active projection только после catch-up и validation.

В переходном локальном режиме то же действие можно запустить через API, но UI
предпочтительнее, поскольку требует подтверждение и показывает обе проекции:

```bash
curl -fsS -X POST http://127.0.0.1:48091/v1/index/rebuild \
  -H 'content-type: application/json' \
  -d '{"reason":"full rebuild from primary Mycelia MongoDB"}' | jq .
```

### Как понять, что полный обсчёт закончен

Завершение подтверждается только одновременным выполнением всех условий:

- `/ready` возвращает HTTP 200;
- `state=ready`, `degraded=false`, `paused=false`;
- `progress.phase=idle`, `processedSources=totalSources`;
- `failedSources=0`, operation имеет состояние `succeeded`;
- `.inference.activeProjectionCompatible=true`;
- Qdrant имеет `reachable=true`, `status=green` и ненулевой `pointsCount`;
- все четыре source adapters имеют change stream `watching`, resume token и
  отсутствие error;
- сумма `sources[].chunks` равна `qdrant.pointsCount`;
- privacy-safe Hybrid, Semantic и Lexical smoke проходят с Mongo revalidation.

После первичного запуска подключите основной Docker backend через:

```dotenv
RAG_URL=http://host.docker.internal:48091
RAG_REQUEST_TIMEOUT_MS=15000
```

Запишите эти две строки в ignored-файл `~/repo/mycelia/.env`, не в tracked
`.env.example`. Не выводите рядом с ними остальные значения `.env` в логи или
публичные отчёты.

Затем пересоздайте только backend и перезапустите nginx:

```bash
docker compose up -d --force-recreate backend
docker compose restart nginx
docker compose logs -f backend |
  rg --line-buffered '\[SERVICE\]|\[READY\]|Failed to start|Unhandled|FATAL'
```

Не перезапускайте MongoDB или Redis. После `[READY]` отдельно проверьте
`https://localhost:4433/health`, `/readiness`, Search, Knowledge и Chat tools.

## 3. Быстрая проверка через UI

### Шаг 1. Проверить готовность проекции

Откройте **Settings → Knowledge / RAG** и дождитесь завершения загрузки. Для
здорового runtime должны одновременно выполняться условия:

- **Lifecycle** — `ready`;
- **Qdrant** — `green`;
- **Indexed chunks** — ненулевое значение;
- **Update lag** — небольшой и не растёт постоянно;
- **Projection compatible** — отображается в карточке Inference pipeline;
- операция имеет состояние `succeeded`, а текущая фаза — `idle`;
- у каждого источника **Change stream** равен `watching`;
- нет `failed`-источников, warnings и блока Projection errors.

`/health=200` недостаточно: это только живой процесс. Готовность поиска
подтверждают `/ready=200`, активная совместимая проекция и свежие change stream.

### Шаг 2. Выполнить первый поиск

Откройте **Search**, оставьте режим **Hybrid**, введите нейтральный запрос,
например название известного проекта, и нажмите **Search**.

Проверьте в верхней части результатов:

- фактический режим — `hybrid`;
- projection ID совпадает с активной проекцией на странице Knowledge;
- checkpoint — `watching`;
- lag не указывает на длительное отставание;
- бейдж **Mongo verified**;
- количество sources и contexts ненулевое;
- каждая карточка имеет ссылку **Source** на каноническую запись.

Перейдите по одной ссылке Source и убедитесь, что открывается правильная запись,
сообщение, транскрипт или media asset. Именно каноническая запись, а не Qdrant
payload, подтверждает дату, автора, platform и остальные точные факты.

### Шаг 3. Проверить RAG в Chat

1. Откройте **Chat** и создайте или выберите чат.
2. Откройте селектор **Tools** в заголовке чата.
3. В режиме **Auto** инструмент доступен автоматически. Для явной проверки
   выберите **Custom** и включите **Search** в группе Search. Его техническое
   имя в activity и backend-контракте — `rag_search`.
4. Задайте вопрос, требующий поиска в памяти, например:
   `Найди обсуждения проекта X за май и перечисли источники.`
5. Раскройте activity/tool details и убедитесь, что вызван `rag_search`, а ответ
   ссылается на найденные канонические источники.

Chat получает только read-only инструмент `rag_search`. `rebuild`, `reconcile`,
`pause` и `resume` не являются LLM-инструментами. Автоматическая строгая
проверка соответствия каждой фразы ответа конкретному evidence ID остаётся
отдельным следующим этапом, поэтому важные факты проверяйте по Source-ссылкам.

## 4. Как пользоваться Search

### Режимы поиска

| Режим        | Когда использовать                         | Что проверяет                                        |
| ------------ | ------------------------------------------ | ---------------------------------------------------- |
| **Hybrid**   | Основной режим                             | Совмещает MiniLM semantic retrieval и BM25 через RRF |
| **Semantic** | Перефразирования, разные языки, ASR-ошибки | Сходство смысла, даже если слова не совпали          |
| **Lexical**  | Имена, номера, точные редкие слова         | Совпадение терминов через sparse BM25                |

Hybrid — рекомендуемый baseline. Semantic similarity помогает найти кандидатов,
но сама по себе не доказывает факт или отношение между объектами.

### Детерминированные фильтры

| Поле                         | Поведение                                                                   |
| ---------------------------- | --------------------------------------------------------------------------- |
| **Source kinds**             | Ограничивает поиск transcriptions, messages, objects или media descriptions |
| **Date and time range**      | Фильтрует по каноническому времени и пересечению интервалов                 |
| **Exact platforms**          | Принимает точные canonical platform IDs через запятую                       |
| **Exact message sender IDs** | Принимает точные `messages.senderId`; это не voice/speaker filter           |
| **Exact source type + ID**   | Ограничивает поиск одной канонической MongoDB-записью                       |
| **Evidence per context**     | Ограничивает соседние chunks из одного чата, recording или source           |
| **Result limit**             | Ограничивает итоговый compact evidence set                                  |

Фильтры применяются сначала к payload-кандидатам Qdrant, затем повторно к
актуальным MongoDB-записям. Обновлённый, удалённый или переставший подходить
кандидат должен быть отброшен при revalidation.

### Что означают метрики результата

- **projection** — версия проекции, из которой получены кандидаты;
- **checkpoint / lag** — свежесть инкрементального обновления;
- **Mongo verified** — источники повторно прочитаны и проверены в MongoDB;
- **stale dropped** — устаревшие Qdrant-кандидаты исключены;
- **exact-filter refined** — MongoDB уточнила interval или exact filter;
- **sources** — число разных канонических источников;
- **contexts** — число разных чатов, recordings или source-групп;
- **score** — релевантность для discovery, а не вероятность истинности факта.

### Минимальный acceptance-проход

1. Выполните один и тот же запрос в Hybrid, Semantic и Lexical.
2. Ограничьте запрос одним Source kind — результаты других типов должны
   исчезнуть.
3. Задайте период, в котором точно есть обсуждение, затем заведомо неверный
   период — второй запрос должен вернуть пустой evidence set.
4. Для сообщения проверьте правильный exact platform/sender ID, затем замените
   его на `__rag_negative_check__` — результатов быть не должно.
5. Скопируйте source type и ID одного результата в Exact source — должен
   остаться только указанный источник.
6. Поставьте **Evidence per context = 1** и убедитесь, что один чат или
   recording не заполняет весь результат соседними chunks.
7. Перейдите по Source-ссылке хотя бы одного результата.

Не используйте пустой результат как доказательство отсутствия факта, если UI
показывает degraded retrieval, checkpoint error, paused с большим lag или
недоступную Mongo revalidation.

## 5. Как пользоваться Knowledge / RAG

### Inference pipeline

Карточка показывает полный контракт текущего baseline:

- profile и fingerprint;
- dense model, revision, tokenizer, instructions, dimensions и normalization;
- sparse BM25 model и tokenizer;
- executor и факт загрузки моделей;
- reranker status;
- совместимость активной проекции с текущим runtime.

Для Stage 1 ожидаются MiniLM, 384 dimensions, L2 normalization, Qdrant/BM25,
локальный FastEmbed 0.8.0 и `Reranker disabled`. Будущий Qwen3 768d должен быть
отдельной projection-v2; смешивать его vectors с MiniLM-проекцией нельзя.

### Active projection и progress

Проверяйте:

- Projection ID, collection и generation;
- полный projection fingerprint;
- model, chunker и source-schema fingerprints;
- processed / total sources и progress bar;
- indexed и failed counts;
- тип, состояние, время и ошибку последней операции;
- Qdrant capabilities: dense, sparse, hybrid RRF и payload filters.

Rebuild работает blue/green: старая активная проекция остаётся доступной для
поиска, пока новая collection строится и догоняет изменения.

### Source coverage and freshness

Таблица разбивает полноту по адаптерам:

- `transcriptions`;
- `messages`;
- `objects`;
- `media_visual_descriptions`.

`Documents` и `Indexed` могут немного отличаться: документ без индексируемого
текста учитывается в ledger, но не создаёт chunk. Сумма `Chunks` должна
совпадать с Qdrant `pointsCount`.

Для каждого источника проверяйте `watching`, наличие checkpoint, lag, последнюю
reconcile и отсутствие ошибки.

### Inspect indexed chunks

Этот раздел позволяет:

- фильтровать chunks по kind и exact canonical source ID;
- видеть point ID, chunk index и content hash;
- переходить по ссылке в канонический Source;
- проверять, что chunks принадлежат активной projection ID.

Раздел read-only: он не редактирует точки Qdrant. Текст chunks является личными
данными — не копируйте его в issue, публичный лог или скриншот.

### Кнопки управления

| Кнопка                 | Что делает                                                  | Когда использовать                                        |
| ---------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| **Refresh**            | Только перечитывает status                                  | Для обновления экрана                                     |
| **Reconcile**          | Идемпотентно сравнивает MongoDB, ledger и активную проекцию | Пропущенное обновление, подозрение на drift               |
| **Pause updates**      | Останавливает индексные мутации, сохраняя поиск             | Низкий диск, диагностика, обслуживание inference          |
| **Resume updates**     | Продолжает с durable checkpoint и догоняет изменения        | После устранения причины pause                            |
| **Rebuild projection** | Строит новую versioned collection и атомарно активирует её  | Новая embedding/chunking/schema версия или полный rebuild |

Rebuild требует подтверждения и может занять часы. Не запускайте второй rebuild,
пока предыдущая операция `running`. Перед ним проверяйте свободный диск. При
остатке меньше 8 GiB сначала нажмите **Pause updates** и диагностируйте причину;
ничего не удаляйте автоматически.

## 6. Проверка без UI

Следующие команды не печатают тексты источников.

### Контейнеры и порты текущего full-data stack

```bash
docker ps \
  --filter label=com.docker.compose.project=mycelia-rag-full \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

curl -fsS http://127.0.0.1:48091/health
curl -fsS http://127.0.0.1:48091/ready
curl -fsS http://127.0.0.1:46333/readyz
```

Ожидаются HTTP 200. Контейнеры отдельного проекта не должны заменять или
перезапускать `mycelia-mongo-1`, `mycelia-redis-1` и основной backend.

### Privacy-safe status

```bash
curl -fsS http://127.0.0.1:48091/v1/status | jq '{
  state,
  degraded,
  paused,
  activeProjectionId,
  compatible: .inference.activeProjectionCompatible,
  authMode,
  operation: (.operation | {type, state}),
  progress: (.progress | {
    phase, processedSources, totalSources, failedSources
  }),
  qdrant: (.qdrant | {
    reachable, status, pointsCount, indexedVectorsCount
  }),
  sources: [.sources[] | {
    kind, documents, indexedDocuments, chunks,
    changeStream: (.changeStream | {
      state, resumeTokenPresent, lagSeconds
    })
  }]
}'
```

### Privacy-safe hybrid smoke

Команда обрабатывает результаты, но выводит только агрегаты и типы источников:

```bash
curl -fsS -X POST http://127.0.0.1:48091/v1/search \
  -H 'content-type: application/json' \
  -d '{
    "query": "известное название проекта",
    "mode": "hybrid",
    "limit": 3,
    "maxPerSource": 1
  }' | jq '{
    projectionId,
    mode,
    degraded,
    freshness,
    revalidation,
    selection,
    returned: (.results | length),
    kinds: ([.results[].source.kind] | unique)
  }'
```

В переходном локальном режиме этот прямой `/v1/*` вызов работает при
`RAG_AUTH_MODE=none`. При `internal_token` используйте bearer token только из
локального secret store и не вставляйте его в документацию или логи. Обычный UI
всегда должен обращаться через `/api/resource/rag` основного backend.

### Основной backend

```bash
curl -fkSs https://localhost:4433/health
curl -fkSs https://localhost:4433/readiness

docker inspect mycelia-backend-1 \
  --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'

docker inspect mycelia-backend-1 \
  --format '{{range .Config.Env}}{{println .}}{{end}}' |
  rg '^(APP_MODE|RAG_URL|RAG_REQUEST_TIMEOUT_MS)='

docker logs --since 15m mycelia-backend-1 2>&1 |
  rg '\[SERVICE\]|\[READY\]|Failed to start|Unhandled|FATAL'
```

Для текущего Docker backend ожидаются:

```text
APP_MODE=dev
RAG_URL=http://host.docker.internal:48091
RAG_REQUEST_TIMEOUT_MS=15000
```

После изменения этих переменных recreate только backend и затем nginx. Не
перезапускайте MongoDB или Redis ради reload приложения. Дождитесь `[READY]`, а
затем отдельно проверьте health и readiness.

### Диск и volumes

```bash
df -h .
docker exec mycelia-rag-full-rag-1 du -sh /data /models
docker exec mycelia-rag-full-qdrant-1 du -sh /qdrant/storage
```

`docker compose down` сохраняет volumes. Не используйте `down -v`, если не
принято явное решение полностью выбросить и перестроить проекцию.

## 7. Проверенный reference snapshot

Это ориентир успешной full-data проверки от 2026-08-29, а не неизменяемый
production count. После новых данных totals могут увеличиваться.

| Показатель             | Проверенное значение                                               |
| ---------------------- | ------------------------------------------------------------------ |
| Локальная `sky-uat`    | `e55fc315be67c0dfca06a74cc6e852f4894ec704`                         |
| Projection ID          | `d5016655a8dd-20260828T231551Z-38067e`                             |
| Projection fingerprint | `d5016655a8ddc2d245c97ce3699433c2324587e05e18d9c4bc2af7061058cca4` |
| Canonical documents    | `325,768`                                                          |
| Indexed documents      | `325,765`                                                          |
| Qdrant points / chunks | `409,992`                                                          |
| Transcriptions         | `70,293` documents / `109,866` chunks                              |
| Messages               | `443` documents / `440` indexed / `3,530` chunks                   |
| Objects                | `255,032` documents / `296,596` chunks                             |
| Media descriptions     | `0` documents / `0` chunks                                         |
| Change streams         | все 4 `watching`, resume token есть, lag `0`                       |
| Runtime                | `ready`, `idle`, `failedSources=0`, Qdrant `green`                 |
| Auth migration state   | `RAG_AUTH_MODE=none`, `RAG_REQUIRE_READONLY_MONGO=false`           |

Строгая проверка пересчитала documents, indexedDocuments и chunks через реальные
source adapters + Chunker; сумма chunks совпала с `pointsCount`. Hybrid,
Semantic, Lexical, exact kind/date/source/platform/sender и отрицательные
фильтры прошли. Backend resource, `rag_search`, Search и Knowledge UI также были
проверены live. Этот snapshot относится к локальной ветке; он не доказывает, что
тот же commit опубликован в `origin/sky-uat`.

## 8. Диагностика по симптомам

| Симптом                                  | Что проверить сначала                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Search пишет unavailable                 | `RAG_URL` в backend, `/ready`, backend `[READY]`, Resource API error                      |
| Lifecycle `empty`                        | Нужен первый подтверждённый rebuild                                                       |
| Lifecycle `building` долго не меняется   | progress/current source, RAG logs, CPU/RAM, Qdrant health, диск                           |
| Projection incompatible                  | Model/tokenizer/instruction/dimension/chunker fingerprint; нужен новый rebuild            |
| Qdrant не green                          | Qdrant logs, `/readyz`, volume и свободный диск                                           |
| Change stream `retrying/error`           | Mongo replica set, resume token, source error, сеть MongoDB                               |
| Lag растёт                               | Pause state, change-stream errors, reconcile status, нагрузка inference                   |
| `Documents` больше `Indexed`             | Проверьте, есть ли документы без индексируемого текста; это допустимо при нулевых ошибках |
| Search пустой                            | Очистите фильтры, сравните Hybrid/Lexical, проверьте source coverage и Mongo revalidation |
| Chat не показывает Search (`rag_search`) | `RAG_URL` пуст или backend не был recreated; проверьте Tools после `[READY]`              |
| UI показывает старый код                 | Bind mounts, `APP_MODE=dev`, backend/frontend `[READY]`, затем affected-service recreate  |

## 9. Границы текущего этапа

- Qdrant не является канонической БД и не используется для записи фактов.
- Дата, source, platform, `messages.senderId`, object type и relationships
  проверяются детерминированно по MongoDB/object graph.
- Voice speaker filter ещё не реализован: message sender ID нельзя использовать
  как замену speaker/voice profile.
- Mem0, graph memory, Qwen3 projection-v2 и reranker остаются отдельными
  интеграциями.
- Создание read-only MongoDB user, owner-scoped authorization и cross-owner
  leakage tests запланированы отдельной миграцией. До неё `auth none` допустим
  только для локально изолированного RAG API; не публикуйте его в LAN/Internet.
