# Fullstack DevOps — Учебник v2.0 (глубокое издание)

Интерактивный учебник по роадмапу «Путь от JavaScript к Fullstack-разработчику и DevOps-инженеру» — расширенное издание.

80+ глав в 13 разделах. Каждая глава (1800–2600 слов): разбор «под капотом», продакшен-сценарии, раздел «Типичные ошибки и грабли», «Вопросы на собеседовании», «Практика», «Что почитать».

## Деплой

Сайт собирается Astro в статику и публикуется на **GitHub Pages** через GitHub Actions (`.github/workflows/deploy.yml`):

```bash
git push origin main   # сборка и деплой запускаются автоматически
```

Локально:

```bash
npm ci           # установка зависимостей
npm run dev      # dev-сервер → http://localhost:4321/fullstack-devops-textbook/
npm run build    # сборка в dist/
npm run preview  # предпросмотр собранного сайта
```

Важно: сайт живёт по base-пути `/fullstack-devops-textbook/` — это учтено в `astro.config.mjs` (`site`, `base`, `trailingSlash`). Внутренние ссылки в контенте должны включать base-префикс.

## Структура контента

```
src/content/docs/
├── index.mdx                  # главная (splash)
├── intro/                     # введение, философия, план действий
├── 01-js-core/                # 9 глав: контексты, замыкания, this, прототипы,
│                              #   Event Loop, Promise, async/await, память
├── 02-typescript/             # 5 глав: система типов, дженерики, mapped-типы,
│                              #   satisfies/const/branded
├── 03-react/                  # 9 глав: рендеринг, хуки, состояние, формы,
│                              #   роутер, тестирование
├── 04-nextjs/                 # 7 глав: SSG/SSR/ISR, App Router, RSC, кэш,
│                              #   Server Actions, streaming/edge
├── 05-styling-perf/           # 6 глав: Tailwind, Radix/Shadcn, CSS Modules,
│                              #   a11y, Core Web Vitals
├── 06-nodejs/                 # 6 глав: libuv, стримы, worker_threads, ESM,
│                              #   продакшен
├── 07-nestjs-api/             # 5 глав: DI, жизненный цикл запроса, REST,
│                              #   GraphQL/gRPC
├── 08-data/                   # 7 глав: PostgreSQL (модель/индексы/транзакции),
│                              #   ORM, Redis
├── 09-security-testing/       # 5 глав: JWT/OAuth, веб-безопасность,
│                              #   unit/integration, E2E
├── 10-linux-docker/           # 6 глав: bash, systemd/сети, Docker под капотом,
│                              #   Compose, реестр/безопасность
├── 11-k8s-cicd/               # 6 глав: K8s фундамент/продвинутое/observability,
│                              #   GitHub Actions, GitLab CI/GitOps
├── 12-iac-deploy-obs/         # 6 глав: Terraform, Ansible/Pulumi, Nginx/TLS,
│                              #   логи/метрики, трейсинг/SLO
├── 13-cloud-design-ai/        # 6 глав: AWS, cost, System Design, паттерны, AI
└── appendix/                  # инструментарий Arch Linux, литература и ресурсы
```

Правила оформления глав — в [STYLE_GUIDE.md](./STYLE_GUIDE.md).
Навигация (сайдбар) — в `astro.config.mjs`.

---

DevOps @v_darkpix — Владислав Бородатый
