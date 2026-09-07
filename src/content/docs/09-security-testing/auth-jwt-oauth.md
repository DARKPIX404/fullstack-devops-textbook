---
title: "Аутентификация в деталях: JWT, OAuth 2.0 и хеширование паролей"
description: "JWT изнутри: header/payload/signature, HS256 vs RS256, атаки alg:none, kid-инъекция, слабый секрет. Access/refresh с ротацией и отзывом, OAuth 2.0 гранты, OIDC, Login with Google по шагам, Argon2id и bcrypt."
---

В краткой версии ты видел рабочий минимум: выдать пару токенов, положить refresh в httpOnly cookie, проверять подпись на каждый запрос. Этого хватает для демо, но не хватает для понимания, где именно прячутся дыры. Аутентификация — самая атакуемая часть любого веб-сервиса: пароли утекают из баз, токены крадутся XSS-ом, OAuth-флоу обходятся поддельными редиректами. В этой главе разберём механику JWT до байтов, научимся читать атаки как пентестер и построим полноценную систему: ротация refresh-токенов, чёрный список в Redis, вход через Google с PKCE.

## JWT изнутри: header, payload, signature

JWT — три сегмента, разделённые точками, каждый — Base64URL без паддинга:

```text
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjQyLCJyb2xlIjoiYWRtaW4iLCJleHAiOjE3MzU2MDAwMDB9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c
└──────── header ────────┘ └──────── payload ────────┘ └──────── signature ────────┘
```

Декодируем header и payload (это просто JSON, декодируется кем угодно — JWT не шифрует данные, а только подписывает):

```json
// header
{ "alg": "HS256", "typ": "JWT" }
// payload (claims)
{ "sub": 42, "role": "admin", "iat": 1735596400, "exp": 1735600000 }
```

Подпись считается по формуле: `HMACSHA256(base64(header) + "." + base64(payload), secret)`. Сервер, получив токен, пересчитывает подпись своим секретом. Не сошлась — токен отбрасывается. Ключевое свойство: изменить хоть один байт payload (например, `role: "user"` → `"admin"`) невозможно без пересчёта подписи, а секрет знает только сервер.

:::note[Стандартные claims]
`sub` — идентификатор субъекта, `iat` — время выпуска, `exp` — истечение, `nbf` — не валиден раньше, `iss` — кто выпустил, `aud` — для кого предназначен. Проверяй `aud` и `iss`, если токенов в системе больше одного вида — иначе токен от сервиса A примет сервис B. Полный перечень claims — в [RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519).
:::

В payload не клади ничего секретного: пароль, email в открытом виде, PII. Base64 — это кодирование, а не шифрование: любой декодер покажет всё. Удобно разбирать структуру интерактивно на [jwt.io](https://jwt.io/introduction) — тот же формат header/payload/signature, только с живым дебаггером подписи.

## HS256 vs RS256: модель доверия

Два алгоритма, две разные архитектуры доверия:

- **HS256 (HMAC)** — симметричный: один и тот же секрет подписывает и проверяет. Просто, быстро, но секрет должен знать каждый сервис, который проверяет токены. Микросервис, которому нужно только читать токены, получает право и подделывать их.
- **RS256 (RSA)** — асимметричный: приватный ключ подписывает на сервере авторизации, публичный ключ проверяет везде. Публичный ключ можно раздать хоть в README — подписать им нельзя.

```ts
// выпуск — только на auth-сервисе, приватный ключ живёт в секрет-хранилище
const token = jwt.sign({ sub: user.id, role: user.role }, privateKey, {
  algorithm: 'RS256',
  expiresIn: '10m',
  audience: 'orders-api', // aud проверяется при верификации
  issuer: 'auth.example.com',
});

// проверка — на любом сервисе, публичного ключа достаточно
const payload = jwt.verify(token, publicKey, {
  algorithms: ['RS256'], // <<< жёстко фиксируем список алгоритмов
  audience: 'orders-api',
  issuer: 'auth.example.com',
});
```

:::caution[Всегда передавай algorithms]
Если библиотеке не сказать, какие алгоритмы допустимы, она может принять то, что написано в header токена. Это прямой путь к атаке `alg: none` — ниже разберём. Правило: `algorithms: ['RS256']` — всегда, без исключений.
:::

Для монолита HS256 нормален. RS256 нужен, когда токен проверяют несколько независимых сервисов или фронтенд-микросайты — классика enterprise и SSO.

## Атаки на JWT и защита

### alg: none

Старейшая атака: header `{ "alg": "none" }`, пустая подпись, а в payload — `role: "admin"`. Уязвимые библиотеки принимали такой токен как валидный.

```text
# вариант атакующего (подпись пустая, но точка на конце обязательна)
eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOjQyLCJyb2xlIjoiYWRtaW4ifQ.
```

Защита — одна строка: явный список алгоритмов при верификации. Все современные библиотеки по умолчанию отклоняют `none`, но дешёвые кастомные реализации до сих пор всплывают в пентестах. Разбор типовых ошибок при работе с JWT (включая `alg: none` и подмену алгоритма) дан в [RFC 8725 — JWT Best Current Practices](https://datatracker.ietf.org/doc/html/rfc8725).

### kid-инъекция и подмена алгоритма

`kid` (key id) в header указывает, каким ключом проверять. Если сервер подставляет `kid` в путь файла или SQL-запрос без санитайза:

```json
{ "alg": "HS256", "kid": "../../../dev/null" }
```

или классический трюк: если сервер хранит публичный ключ для RS256 и позволяет в header сказать `alg: HS256`, атакующий подписывает токен **публичным ключом сервера как HMAC-секретом** — а сервер проверяет его же. Защита: алгоритм выбирается сервером по типу ключа, `kid` — строгий маппинг `kid → ключ` из конфига, никакой строковой подстановки.

### Слабый секрет

HS256 с секретом `secret123` взламывается за секунды перебором по словарю: подпись пересчитывается для каждого кандидата, совпала — секрет найден. Инструменты вроде `hashcat` делают это на GPU со скоростью миллионы вариантов в секунду. Правила: секрет ≥ 32 байта энтропии (`openssl rand -base64 32`), секреты не в коде и не в git — только в env/секрет-хранилище, ротация при малейшем подозрении на утечку, отдельные секреты для окружений.

:::tip[Проверь себя]
Полези через jwt.io токен с твоего dev-окружения и спроси: «что атакующий узнает из payload, что изменится, если секрет утечёт, сколько времени токен живёт после кражи?». Если на любой вопрос нет ответа — настройка не закончена.
:::

## Access/refresh: ротация и отзыв

Два токена решают конфликт: access короткий (5–15 минут) ходит с запросами, refresh длинный (7–30 дней) живёт в httpOnly cookie и тратится только на `/auth/refresh`.

```ts
// POST /auth/refresh — ротация: каждый refresh используется один раз
app.post('/auth/refresh', async (req, res) => {
  const token = req.cookies.refreshToken;
  if (!token) return res.sendStatus(401);

  const payload = jwt.verify(token, REFRESH_SECRET);
  // refresh-токены храним в Redis: user:{id}:refresh → jti, TTL = срок жизни
  const stored = await redis.get(`user:${payload.sub}:refresh`);
  if (stored !== payload.jti) {
    // токен не найден или jti не совпал — возможен кража: гасим всю сессию
    await redis.del(`user:${payload.sub}:refresh`);
    return res.sendStatus(401);
  }

  const newJti = crypto.randomUUID();
  await redis.set(`user:${payload.sub}:refresh`, newJti, 'EX', 7 * 24 * 3600);

  setRefreshCookie(res, signRefresh(payload.sub, newJti)); // новый refresh
  res.json({ accessToken: signAccess(payload.sub) });        // новый access
});
```

Ротация с хранением `jti` в Redis даёт два свойства: **отзыв** (`DEL` ключа — сессия мёртва, даже если refresh не истёк) и **детект кражи** (старый refresh переиспользовали — значит, его скопировали, инвалидируем всё). Логаут — тот же `DEL` плюс access-токен в чёрный список на оставшееся время жизни:

```ts
// чёрный список access: SET jti "1" EX (exp - now)
await redis.set(`bl:${accessJti}`, '1', 'EX', payload.exp - Math.floor(Date.now() / 1000));
// middleware проверяет: EXISTS bl:{jti} → 401
```

## Хранение токенов на клиенте: cookie vs localStorage

Дилемма: где держать access-токен на фронтенде.

| Хранилище | XSS | CSRF |
|---|---|---|
| `localStorage` | JS читает — украден одним скриптом | не подвержен (куки нет) |
| `httpOnly cookie` | JS не читает — украсть сложнее | подвержен, нужен SameSite + защита |

:::caution[CSRF-проблема cookie]
Если auth-cookie шлётся автоматически, чужой сайт может формой/запросом инициировать действие от имени пользователя. Поэтому cookie всегда с `SameSite=Lax` (или `Strict` — семантика значений описана в [MDN: заголовок Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie)), а для изменяющих запросов с cross-site сценариями — CSRF-токен или проверка заголовка `Origin`. Разбор — в главе [Веб-безопасность](/09-security-testing/web-security/).
:::

Практичная схема: **access в памяти приложения** (переменная модуля, теряется при перезагрузке страницы — не страшно, берём новый по refresh), **refresh в httpOnly + Secure + SameSite cookie**. Никогда не клади access в localStorage — любой XSS превращается в угон сессии.

## Сессии vs JWT

Сессия — состояние на сервере (Redis: `sessionId → user`), клиент хранит лишь идентификатор в cookie. JWT — состояние в токене, сервер хранит ничего (почти). Таблица выбора:

| Критерий | Сессии | JWT |
|---|---|---|
| Отзыв | мгновенный — удалил запись | нужен чёрный список/хранение jti |
| Масштабирование | общий Redis для всех нод | подпись проверяется локально |
| Нагрузка на хранилище | каждый запрос — lookup | только refresh/отзыв |
| Данные в токене | только id | claims доступны клиенту |

Модный вывод 2026 года: гибрид. Refresh-токены — фактически сессии (храним в Redis, отзываем), access — чистый JWT (быстрая локальная проверка, короткая жизнь). Это и есть схема, которую мы построили выше.

## OAuth 2.0: гранты

OAuth решает задачу делегированного доступа: пользователь даёт приложению право действовать от его имени у провайдера (Google, GitHub), не сообщая приложению свой пароль. Ниже — практические гранты; каноническое описание флоу — [RFC 6749, The OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749).

**Authorization Code + PKCE** — единственный грант для публичных клиентов (SPA, мобильные). PKCE (Proof Key for Code Exchange) закрывает атаку перехвата кода: клиент генерирует случайный `code_verifier`, шлёт его хеш (`code_challenge`) на авторизацию, а при обмене кода на токен предъявляет исходный verifier — сервер сверяет хеш. Перехвативший код без verifier бесполечен.

**Client Credentials** — машина к машине: бэкенд сервиса A получает токен для сервиса B по `client_id` + `client_secret`. Без пользователя вообще.

**Device Authorization Grant** — ТВ, консоли, CLI: устройство показывает код, пользователь вводит его на другом устройстве с браузером. Устройство поллит токен, пока пользователь не подтвердит.

## OIDC: идентичность поверх OAuth

OAuth отвечает «чему приложение может делать», но не «кто пользователь». **OpenID Connect** добавляет поверх: `id_token` — JWT с claims пользователя (`sub`, `email`, `name`, `picture`, `email_verified`), и стандартный эндпоинт `userinfo`, отдающий профиль по access token. Практические правила: валидируй подпись id_token ключами провайдера (JWKS-эндпоинт, кэшируй ключи), проверяй `iss`, `aud`, `exp`, `nonce` против того, что слал в запросе. `sub` — стабильный идентификатор, email может смениться.

## Login with Google: по шагам

1. В Google Cloud Console создаёшь OAuth Client ID (тип Web application), указываешь `redirect_uri`: `https://app.example.com/api/auth/google/callback`. Секрет — в env.
2. Кнопка «Войти через Google» ведёт на:

```text
https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=...&redirect_uri=...&response_type=code
  &scope=openid%20email%20profile
  &state=<csrf-state>&code_challenge=<sha256(verifier)>&code_challenge_method=S256
```

3. Google редиректит на callback с `?code=...&state=...`. Сверяешь `state` с сессионным — иначе это CSRF.
4. Backend меняет код на токены (секрет — только на сервере!):

```ts
const tokens = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code, client_id, client_secret, grant_type: 'authorization_code',
    redirect_uri: CALLBACK, code_verifier: storedVerifier,
  }),
}).then(r => r.json());
// tokens: { access_token, id_token, refresh_token? }
```

5. Декодируешь и валидируешь `id_token` (подпись по Google JWKS, `aud` = твой client_id, `iss` = accounts.google.com). По `sub` ищешь локального пользователя; нет — создаёшь. Выдаёшь свою пару access/refresh — и дальше работаешь со своей системой, как после обычного логина.

:::tip[Не пиши OAuth руками в проде]
Для обучения — обязательно, один раз, по шагам. В проде бери битлиотеку: `openid-client` (Node), Auth.js, Lucia. Они закрывают PKCE, state, nonce, JWKS-кэширование и десяток менее известных граблей спецификации.
:::

**SSO кратко**: когда у компании несколько внутренних сервисов, вместо N логинов ставится Identity Provider (Keycloak, Okta, Entra ID). Сервисы доверяют общим ключам, пользователь логинится один раз — это тот же OIDC, только `iss` общий и есть протоколы федерации (SAML для легаси).

## Хеширование паролей

Пароли хешируются, а не шифруются: шифрование обратимо, хеш — нет. Требования к алгоритму: медленный (замедляет перебор), с солью (уникальной per-пароль, ломает rainbow-таблицы), устойчивый к GPU/ASIC.

**Argon2id** — победитель Password Hashing Competition, текущий стандарт. Параметры:

```ts
import argon2 from 'argon2';

const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 19456,  // 19 MiB — защита от GPU (параллелизм по памяти)
  timeCost: 2,        // проходы
  parallelism: 1,     // потоки
});

const ok = await argon2.verify(user.passwordHash, password);
```

Ориентир калибровки: верификация 100–300 мс на твоём железе. OWASP для bcrypt рекомендует cost ≥ 10; bcrypt ограничен 72 байтами ввода — длинные пароли хешируй предварительно через SHA-256. Никогда не сравнивай хеши «на глаз» через `===` — только через `verify`, иначе тайминг-атака.

## Типичные ошибки и грабли

1. **Токены в localStorage.** Любой XSS читает их и угоняет сессию. Access — в память, refresh — httpOnly cookie.
2. **Бесконечный access без отзыва.** «Нам нечего скрывать» — до первого угона токена админа. Access 5–15 минут + чёрный список в Redis.
3. **`jwt.verify` без `algorithms`.** Дверь для `alg: none` и подмены RS256→HS256. Всегда фиксируй список.
4. **Секреты в репозитории.** `JWT_SECRET=secret` в `.env`, закоммиченном в git, — классика утечек. `.env` в `.gitignore` с первого коммита, секреты — в менеджер секретов, сканирование репозитория на секреты в CI (gitleaks, trufflehog).
5. **Различающиеся ответы для «нет юзера» и «неверный пароль».** Атакующий перебирает существующие email. Ответ один: «неверный email или пароль», время ответа — одинаковое.
6. **Refresh без ротации.** Украденный refresh работает неделями. Ротация + детект переиспользования обязательны.
7. **Доверие к данным из JWT без проверки владения.** Токен валиден ≠ пользователь имеет право на ресурс `id=123`. Авторизация — отдельная проверка на каждом запросе.

## Вопросы на собеседовании

1. **Чем HS256 отличается от RS256 и когда что брать?** HS256 — симметричный, один секрет на подпись и проверку, годится для монолита. RS256 — асимметричный, подписывает приватный ключ, проверяет публичный — нужен, когда токен проверяют независимые сервисы или нужно дать проверку без права подписи.
2. **Что такое атака `alg: none` и как защититься?** Поддельный токен с алгоритмом none и пустой подписью; уязвимые библиотеки его принимали. Защита — явный список допустимых алгоритмов в `verify`.
3. **Почему JWT нельзя просто отозвать?** Подпись валидна до `exp`, проверка локальная. Поэтому access короткий, а отзыв делается через чёрный список jti в Redis или хранение refresh-сессий с `DEL`.
4. **Зачем PKCE и что он защищает?** От перехвата кода авторизации: код без `code_verifier` бесполезен. Перехватчик не знает исходный verifier, который клиент генерировал до редиректа.
5. **Cookie vs localStorage для токенов?** Cookie (httpOnly) невидимы для JS — устойчивее к XSS, но создают CSRF-риск, закрываемый SameSite. localStorage читается любым скриптом — одна XSS равна угону сессии.
6. **Почему Argon2id, а не SHA-256 для паролей?** SHA-256 быстрый на GPU — триллионы перебора в секунду. Argon2id параметризуем по памяти и времени: ~100–300 мс на проверку делает перебор экономически бессмысленным, плюс соль блокирует rainbow-таблицы.
7. **Что проверить в id_token от Google?** Подпись по JWKS Google, `iss` = accounts.google.com, `aud` = твой client_id, `exp`, `nonce` против отправленного.

## Практика

1. Реализуй `/auth/login`, `/auth/refresh`, `/auth/logout` с полной схемой: Argon2id-хеш пароля, access 10 минут, refresh 7 дней в httpOnly cookie, ротация с хранением `jti` в Redis, logout через `DEL` + чёрный список access. Критерий: после logout украденный refresh возвращает 401, повторное использование старого refresh гасит сессию.
2. Слабый секрет: создай в отдельной ветке JWT с секретом `secret123` и взломай его перебором скриптом на 1000 частых паролей. Зафиксируй в README время взлома — это аргумент за длинные секреты.
3. «Вход через Google» по шагам из главы: PKCE с `code_verifier` в памяти SPA, `state` в cookie, обмен кода на сервере. Критерий: вход работает, а подмена `state` на callback обрывается с 403.
4. Напиши middleware, который фиксирует список алгоритмов `['RS256']`, и тест, доказывающий, что токен с `alg: none` и токен, подписанный публичным ключом как HS256, отклоняются.
5. Сравни время ответа `/auth/login` для существующего и несуществующего email; выровняй их (одинаковый Argon2-dummy-verify для несуществующего пользователя).

## Что почитать

- [RFC 7519 — JWT](https://datatracker.ietf.org/doc/html/rfc7519) и [RFC 8725 — Best Practices](https://datatracker.ietf.org/doc/html/rfc8725)
- [OWASP JWT Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)
- [RFC 7636 — PKCE](https://datatracker.ietf.org/doc/html/rfc7636) и [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/rfc9700)
- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html) — спецификация id_token
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [openid-client — документация](https://github.com/panva/node-openid-client)
