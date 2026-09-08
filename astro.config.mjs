// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://book.darkpix.ru',
	trailingSlash: 'always',
	integrations: [
		starlight({
			title: 'Fullstack DevOps — Учебник v2',
			description: 'Глубокое издание: путь от JavaScript к Fullstack-разработчику и DevOps-инженеру. Разбор под капотом, продакшен-практики, собеседования.',
			locales: {
				root: {
					label: 'Русский',
					lang: 'ru',
				},
			},
			defaultLocale: 'root',
			logo: {
				src: './src/assets/logo.svg',
				replacesTitle: false,
			},
			lastUpdated: true,
			pagination: true,
			expressiveCode: {
				themes: ['github-dark-dimmed', 'github-dark'],
				useStarlightUiThemeColors: false,
				styleOverrides: {
					borderRadius: '8px',
					codeFontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
				},
			},
			tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
			pagefind: true,
			customCss: [
				'./src/styles/custom.css',
				'./src/fonts/fonts.css',
			],
			sidebar: [
				{
					label: 'Начало',
					items: [
						{ label: 'Главная', slug: 'index' },
						{ label: 'Введение и философия', slug: 'intro/philosophy' },
						{ label: 'План действий', slug: 'intro/action-plan' },
					],
				},
				{
					label: 'Git — всё-всё-всё',
					items: [
						{ label: 'Обзор раздела', slug: '00-git' },
						{ label: 'Git под капотом: объекты и .git', slug: '00-git/internals' },
						{ label: 'Рабочий цикл: add, commit, staging', slug: '00-git/staging-commit' },
						{ label: 'Ветвление и HEAD', slug: '00-git/branching' },
						{ label: 'Merge и rebase глубоко', slug: '00-git/merge-rebase' },
						{ label: 'Удалённые репозитории и PR', slug: '00-git/remote' },
						{ label: 'Стратегии ветвления', slug: '00-git/workflows' },
						{ label: 'Продвинутый Git', slug: '00-git/advanced' },
					],
				},
				{
					label: 'JS Core',
					items: [
						{ label: 'Обзор раздела', slug: '01-js-core' },
						{ label: 'Контекст выполнения и Lexical Environment', slug: '01-js-core/execution-context' },
						{ label: 'Замыкания в деталях', slug: '01-js-core/closures' },
						{ label: 'this и контекст вызова', slug: '01-js-core/this' },
						{ label: 'Прототипы и классы', slug: '01-js-core/prototypes' },
						{ label: 'Event Loop в браузере', slug: '01-js-core/event-loop-browser' },
						{ label: 'Promise под капотом', slug: '01-js-core/promise-in-depth' },
						{ label: 'async/await, AbortController, top-level await', slug: '01-js-core/async-await' },
						{ label: 'Память: утечки, GC, WeakRef', slug: '01-js-core/memory' },
					],
				},
				{
					label: 'TypeScript',
					items: [
						{ label: 'Обзор раздела', slug: '02-typescript' },
						{ label: 'Система типов и сужение', slug: '02-typescript/type-system' },
						{ label: 'Дженерики и infer', slug: '02-typescript/generics' },
						{ label: 'Условные и mapped-типы, утилиты', slug: '02-typescript/advanced-types' },
						{ label: 'satisfies, as const, branded types, tsconfig', slug: '02-typescript/satisfies-const-branded' },
					],
				},
				{
					label: 'CSS Core',
					items: [
						{ label: 'Обзор раздела', slug: '02-css-core' },
						{ label: 'Каскад, специфичность, бокс-модель', slug: '02-css-core/fundamentals' },
						{ label: 'Flexbox в деталях', slug: '02-css-core/flexbox' },
						{ label: 'CSS Grid в деталях', slug: '02-css-core/grid' },
						{ label: 'Позиционирование и stacking contexts', slug: '02-css-core/positioning' },
						{ label: 'Анимации и адаптивная вёрстка', slug: '02-css-core/animations-responsive' },
					],
				},
				{
					label: 'CSS-фреймворки и инструменты',
					items: [
						{ label: 'Обзор раздела', slug: '02-css-frameworks' },
						{ label: 'Препроцессоры: Sass и PostCSS', slug: '02-css-frameworks/preprocessors' },
						{ label: 'Bootstrap 5 глубоко', slug: '02-css-frameworks/bootstrap' },
						{ label: 'Utility-first: UnoCSS, daisyUI', slug: '02-css-frameworks/utility-alternatives' },
						{ label: 'CSS-in-JS: styled-components, Linaria', slug: '02-css-frameworks/css-in-js' },
						{ label: 'Компонентные библиотеки: MUI, Chakra, Mantine', slug: '02-css-frameworks/component-libraries' },
					],
				},
				{
					label: 'React',
					items: [
						{ label: 'Обзор раздела', slug: '03-react' },
						{ label: 'Рендеринг и reconciliation', slug: '03-react/rendering' },
						{ label: 'useState и useEffect глубоко', slug: '03-react/state-effects' },
						{ label: 'useMemo, useCallback, useRef, useReducer', slug: '03-react/memo-ref-reducer' },
						{ label: 'Продвинутые хуки и кастомные хуки', slug: '03-react/advanced-hooks' },
						{ label: 'Управление состоянием: Zustand, RTK, Query', slug: '03-react/state-management' },
						{ label: 'Формы: React Hook Form + Zod', slug: '03-react/forms' },
						{ label: 'React Router v6: data routers', slug: '03-react/router' },
						{ label: 'Тестирование React-компонентов', slug: '03-react/testing-react' },
					],
				},
				{
					label: 'Next.js',
					items: [
						{ label: 'Обзор раздела', slug: '04-nextjs' },
						{ label: 'Стратегии рендеринга: SSG, SSR, ISR', slug: '04-nextjs/rendering-strategies' },
						{ label: 'App Router: файловые соглашения', slug: '04-nextjs/app-router' },
						{ label: 'Server Components и гидратация', slug: '04-nextjs/server-components' },
						{ label: 'Data fetching и кэширование', slug: '04-nextjs/data-fetching' },
						{ label: 'Server Actions', slug: '04-nextjs/server-actions' },
						{ label: 'Streaming, Middleware, Edge, next/image', slug: '04-nextjs/streaming-edge' },
					],
				},
				{
					label: 'Стили, a11y, Performance',
					items: [
						{ label: 'Обзор раздела', slug: '05-styling-perf' },
						{ label: 'Tailwind CSS глубоко', slug: '05-styling-perf/tailwind-deep' },
						{ label: 'Radix UI и Shadcn', slug: '05-styling-perf/radix-shadcn' },
						{ label: 'CSS Modules, PostCSS, Container Queries', slug: '05-styling-perf/css-modern' },
						{ label: 'Доступность (a11y)', slug: '05-styling-perf/a11y' },
						{ label: 'Core Web Vitals и оптимизация', slug: '05-styling-perf/web-vitals' },
					],
				},
				{
					label: 'Node.js',
					items: [
						{ label: 'Обзор раздела', slug: '06-nodejs' },
						{ label: 'Event Loop Node.js и libuv', slug: '06-nodejs/event-loop-node' },
						{ label: 'Streams и backpressure', slug: '06-nodejs/streams-backpressure' },
						{ label: 'Многопоточность: cluster, worker_threads, child_process', slug: '06-nodejs/multithreading' },
						{ label: 'CJS vs ESM, циклические зависимости', slug: '06-nodejs/modules-cjs-esm' },
						{ label: 'Монорепозитории и DX', slug: '06-nodejs/monorepos-dx' },
						{ label: 'Node.js в продакшене', slug: '06-nodejs/node-production' },
					],
				},
				{
					label: 'NestJS и API',
					items: [
						{ label: 'Обзор раздела', slug: '07-nestjs-api' },
						{ label: 'NestJS: модули, провайдеры, DI', slug: '07-nestjs-api/nestjs-foundation' },
						{ label: 'Жизненный цикл запроса: Guards, Pipes, Interceptors', slug: '07-nestjs-api/nestjs-request-lifecycle' },
						{ label: 'REST-дизайн и OpenAPI', slug: '07-nestjs-api/rest-design' },
						{ label: 'Realtime API: WebSocket и SSE', slug: '07-nestjs-api/async-realtime' },
						{ label: 'GraphQL, DataLoader, gRPC', slug: '07-nestjs-api/graphql-grpc' },
						{ label: 'Очереди и outbox', slug: '07-nestjs-api/messaging-outbox' },
					],
				},
				{
					label: 'Данные: PostgreSQL и Redis',
					items: [
						{ label: 'Обзор раздела', slug: '08-data' },
						{ label: 'Моделирование и нормализация', slug: '08-data/postgres-modeling' },
						{ label: 'Индексы и EXPLAIN ANALYZE', slug: '08-data/postgres-indexes' },
						{ label: 'Транзакции, изоляция, блокировки', slug: '08-data/postgres-transactions' },
						{ label: 'Бэкапы и восстановление PostgreSQL', slug: '08-data/postgres-backups' },
						{ label: 'Prisma, Drizzle, PgBouncer', slug: '08-data/orm-prisma-drizzle' },
						{ label: 'Redis: кэш-паттерны, сессии, rate limit', slug: '08-data/redis-patterns' },
						{ label: 'Redis: структуры, Pub/Sub, лидерборды', slug: '08-data/redis-structures' },
					],
				},
				{
					label: 'Безопасность и тестирование',
					items: [
						{ label: 'Обзор раздела', slug: '09-security-testing' },
						{ label: 'Аутентификация: JWT, refresh, OAuth/OIDC', slug: '09-security-testing/auth-jwt-oauth' },
						{ label: 'Веб-безопасность: XSS, CSRF, CORS, OWASP', slug: '09-security-testing/web-security' },
						{ label: 'Unit и интеграционные тесты', slug: '09-security-testing/testing-unit-integration' },
						{ label: 'E2E и качество кода', slug: '09-security-testing/testing-e2e-quality' },
					],
				},
				{
					label: 'Linux и Docker',
					items: [
						{ label: 'Обзор раздела', slug: '10-linux-docker' },
						{ label: 'Bash и shell-мастерство', slug: '10-linux-docker/shell-mastery' },
						{ label: 'systemd, сети, nftables, диагностика', slug: '10-linux-docker/systemd-networks' },
						{ label: 'Docker под капотом', slug: '10-linux-docker/docker-deep' },
						{ label: 'Docker Compose в продакшене', slug: '10-linux-docker/docker-compose-prod' },
						{ label: 'Реестр образов и безопасность контейнеров', slug: '10-linux-docker/docker-registry-security' },
						{ label: 'Supply-chain security', slug: '10-linux-docker/supply-chain-security' },
					],
				},
				{
					label: 'Kubernetes и CI/CD',
					items: [
						{ label: 'Обзор раздела', slug: '11-k8s-cicd' },
						{ label: 'Kubernetes: фундамент', slug: '11-k8s-cicd/k8s-fundamentals' },
						{ label: 'Kubernetes: Ingress, Helm, RBAC, Stateful', slug: '11-k8s-cicd/k8s-advanced' },
						{ label: 'Наблюдаемость в Kubernetes', slug: '11-k8s-cicd/k8s-observability' },
						{ label: 'GitHub Actions глубоко', slug: '11-k8s-cicd/github-actions' },
						{ label: 'GitLab CI и GitOps', slug: '11-k8s-cicd/gitlab-ci-gitops' },
					],
				},
				{
					label: 'IaC, деплой, наблюдаемость',
					items: [
						{ label: 'Обзор раздела', slug: '12-iac-deploy-obs' },
						{ label: 'Terraform: state, модули, workspaces', slug: '12-iac-deploy-obs/terraform' },
						{ label: 'Ansible и Pulumi', slug: '12-iac-deploy-obs/ansible-pulumi' },
						{ label: 'Управление секретами и конфигурацией', slug: '12-iac-deploy-obs/secrets-management' },
						{ label: 'Nginx, TLS и стратегии деплоя', slug: '12-iac-deploy-obs/nginx-tls-deploy' },
						{ label: 'Логирование и метрики', slug: '12-iac-deploy-obs/logging-metrics' },
						{ label: 'Трейсинг и алертинг, SLO', slug: '12-iac-deploy-obs/tracing-alerting' },
						{ label: 'Инцидент-менеджмент и postmortem', slug: '12-iac-deploy-obs/incident-management' },
					],
				},
				{
					label: 'Облака, System Design, AI',
					items: [
						{ label: 'Обзор раздела', slug: '13-cloud-design-ai' },
						{ label: 'AWS: EC2, S3, RDS, Lambda, IAM, VPC', slug: '13-cloud-design-ai/cloud-aws' },
						{ label: 'Управление стоимостью облаков', slug: '13-cloud-design-ai/cloud-cost' },
						{ label: 'System Design: масштабирование, CAP, очереди', slug: '13-cloud-design-ai/system-design-fundamentals' },
						{ label: 'System Design: паттерны устойчивости', slug: '13-cloud-design-ai/system-design-patterns' },
						{ label: 'AI-инструменты разработчика', slug: '13-cloud-design-ai/ai-dev-tools' },
					],
				},
				{
					label: 'Приложения',
					items: [
						{ label: 'Инструментарий для Arch Linux', slug: 'appendix/tooling' },
						{ label: 'Литература и ресурсы', slug: 'appendix/resources' },
						{ label: 'Углубление: первоисточники и лабораторные', slug: 'appendix/deep-dive' },
						{ label: 'Глоссарий', slug: 'appendix/glossary' },
						{ label: 'Сводные вопросы на собеседование', slug: 'appendix/interview-questions' },
					],
				},
			],
		}),
	],
});
