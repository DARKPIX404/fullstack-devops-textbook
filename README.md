# Fullstack DevOps — Учебник v2.0 (глубокое издание)

Интерактивный учебник по роадмапу «Путь от JavaScript к Fullstack-разработчику и DevOps-инженеру» — расширенное издание.

90+ глав в 16 разделах. Каждая глава (1800–2600 слов): разбор «под капотом», продакшен-сценарии, раздел «Типичные ошибки и грабли», «Вопросы на собеседовании», «Практика», «Что почитать».

## Деплой

Сайт собирается Astro в статику и публикуется на **GitHub Pages** через GitHub Actions (`.github/workflows/deploy.yml`):

```bash
git push origin main   # сборка и деплой запускаются автоматически
```

Локально:

```bash
npm ci           # установка зависимостей
npm run dev      # dev-сервер → http://localhost:4321/
npm run build    # сборка в dist/
npm run preview  # предпросмотр собранного сайта
```

Важно: сайт публикуется на корень кастомного домена `https://book.darkpix.ru` — base-путь в `astro.config.mjs` не задаётся. Внутренние ссылки в контенте ведут от корня: `/07-nestjs-api/rest-design/`.

## Структура контента

```
src/content/docs/
├── index.mdx                  # главная (splash)
├── intro/                     # введение, философия, план действий
├── 00-git/                    # 7 глав: устройство изнутри, ветвление,
│                              #   merge/rebase, воркфлоу, продвинутые приёмы
├── 01-js-core/                # 8 глав: контексты, замыкания, this, прототипы,
│                              #   Event Loop, Promise, async/await, память
├── 02-typescript/             # 4 главы: система типов, дженерики, mapped-типы,
│                              #   satisfies/const/branded
├── 02-css-core/               # 5 глав: каскад, специфичность, бокс-модель,
│                              #   Flexbox, Grid, адаптив
├── 02-css-frameworks/         # 5 глав: Sass/PostCSS, Bootstrap, UnoCSS/daisyUI,
│                              #   CSS-in-JS, MUI/Chakra/Mantine
├── 03-react/                  # 8 глав: рендеринг, хуки, состояние, формы,
│                              #   роутер, тестирование
├── 04-nextjs/                 # 6 глав: SSG/SSR/ISR, App Router, RSC, кэш,
│                              #   Server Actions, streaming/edge
├── 05-styling-perf/           # 5 глав: Tailwind, Radix/Shadcn, CSS Modules,
│                              #   a11y, Core Web Vitals
├── 06-nodejs/                 # 6 глав: libuv, стримы, worker_threads, ESM,
│                              #   монорепозитории и DX, продакшен
├── 07-nestjs-api/             # 6 глав: DI, жизненный цикл запроса, REST,
│                              #   realtime WebSocket/SSE, GraphQL/gRPC, очереди/outbox
├── 08-data/                   # 7 глав: PostgreSQL (модель/индексы/транзакции/бэкапы),
│                              #   ORM, Redis
├── 09-security-testing/       # 4 главы: JWT/OAuth, веб-безопасность,
│                              #   unit/integration, E2E
├── 10-linux-docker/           # 6 глав: bash, systemd/сети, Docker под капотом,
│                              #   Compose, реестр/безопасность, supply-chain
├── 11-k8s-cicd/               # 5 глав: K8s фундамент/продвинутое/observability,
│                              #   GitHub Actions, GitLab CI/GitOps
├── 12-iac-deploy-obs/         # 7 глав: Terraform, Ansible/Pulumi, секреты,
│                              #   Nginx/TLS, логи/метрики, трейсинг/SLO, инциденты
├── 13-cloud-design-ai/        # 5 глав: AWS, cost, System Design, паттерны, AI
└── appendix/                  # инструментарий Arch Linux, литература и ресурсы,
                               #   углубление, глоссарий, вопросы на собеседование
```

Правила оформления глав — в [STYLE_GUIDE.md](./STYLE_GUIDE.md).
Навигация (сайдбар) — в `astro.config.mjs`.

---

DevOps @v_darkpix — Владислав Бородатый
