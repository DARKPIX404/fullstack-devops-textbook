---
title: "Литература и ресурсы"
description: "Проверенные курсы, книги и первоисточники для пути fullstack + DevOps — от JavaScript-фундамента до Kubernetes и системного дизайна."
---

Это рабочая библиотека для пути. Не пытайся прочитать всё подряд — ресурсы сгруппированы по этапам из [плана действий](/fullstack-devops-textbook/intro/action-plan/). Правило простое: один основной ресурс на тему + первоисточник из документации. Пять туториалов по React не дадут того, что даст один пройденный до конца плюс чтение официальных доков.

## Интерактивные карты и обучение

| Ресурс | Зачем |
|--------|-------|
| [roadmap.sh](https://roadmap.sh) | Карты пути: Frontend, Backend, DevOps, TypeScript, Node.js, React, Docker, Kubernetes. Сверяйся, чтобы не упускать целые области. |
| [javascript.info](https://javascript.info) | Лучший учебник по JS — от основ до продвинутых тем. База для месяцев 1–2. |
| [egghead.io](https://egghead.io) | Короткие практические курсы — идеально для быстрого погружения в новый инструмент. |
| [Frontend Masters](https://frontendmasters.com) | Глубокие курсы по архитектуре фронтенда и DevOps от инженеров из индустрии. |
| [Type Challenges](https://github.com/type-challenges/type-challenges) | Коллекция задач на типы TypeScript — тренажёр уровня medium/expert. |

:::tip[Как работать с курсами]
Смотри урок → сразу пишешь код руками → изменяешь пример, пока не сломаешь → чинишь. Видео без рук на клавиатуре забывается за три дня.
:::

## Книги

| Книга | Этап |
|-------|------|
| Дэвид Флэнаган — «JavaScript. Подробное руководство» | Фундамент (месяц 1–2). Справочник, к которому возвращаешься годами. |
| Mario Casciaro — «Node.js: Паттерны проектирования и производительность» | Backend (месяц 6–9). Паттерны, стримы, масштабирование Node.js. |
| Martin Kleppmann — «Designing Data-Intensive Applications» (DDIA) | Год 2+. Библия системного дизайна: хранилища, репликация, консенсус. Читается медленно — это нормально. |
| «The Phoenix Project» / «The DevOps Handbook» (Kim, Humble, Debois) | DevOps-культура и практики. Phoenix — художественная вводная, Handbook — системный разбор. |
| Шон Смит — «Docker: Ускорение разработки» | Месяц 10–12. Практический Docker от базы до многоступенчатых сборок. |
| Marko Lukša — «Kubernetes in Action» | Год 2+. Лучшее введение в K8s: от подов до сетевой модели. |

:::note[DDIA — не первая книга года]
Не бери Kleppmann до того, как сам настроишь PostgreSQL-реплику или хотя бы поймёшь, зачем нужны индексы. Без боевого контекста книга превращается в набор абстракций. Возвращайся к ней во втором году.
:::

## Первоисточники (документация)

Читай документацию до туториалов: она актуальна, точна и показывает «правильный путь», а не чужой обходной.

| Первоисточник | Тема |
|---------------|------|
| [TypeScript Handbook](https://www.typescriptlang.org/docs/) | Официальный справочник TS. Обязателен после javascript.info. |
| [Next.js Docs](https://nextjs.org/docs) | App Router, Server Components, Server Actions — только из первоисточника, туториалы быстро устаревают. |
| [NestJS Docs](https://docs.nestjs.com) | Модули, DI, Guards, Interceptors — с примерами кода. |
| [Prisma Docs](https://www.prisma.io/docs) | Схемы, миграции, relation-запросы, оптимизация N+1. |
| [Docker Docs](https://docs.docker.com) | Dockerfile reference, Compose specification — читай справочники, а не статьи. |
| [Kubernetes Docs](https://kubernetes.io/docs) | Concepts → Tasks → Reference: лучшая структурированная дока по K8s. |
| [Arch Wiki](https://wiki.archlinux.org) | Лучшая документация по Linux вообще: от настройки сети до восстановления загрузчика. |
| [PostgreSQL Docs](https://www.postgresql.org/docs/) | Конкурентность, транзакции, планировщик запросов. |
| [OWASP Top 10](https://owasp.org/www-project-top-ten/) | Безопасность веб-приложений — проверочный список перед продом. |

:::caution[Туториалы против документации]
Туториал показывает один путь — часто устаревший. Документация показывает все пути. Когда код из туториала не работает, первым делом сверяй версии пакетов с официальной докой: 90% «сломанных» примеров — это рассинхрон версий.
:::

## Практика

1. Заведи закладки-папки «Learn» в браузере: одна на этап плана, клади туда только то, что реально прочитал.
2. Пройди [Type Challenges](https://github.com/type-challenges/type-challenges) до medium — это проверка фундамента перед React.
3. Подпишись на changelog одного инструмента из своего стека (например, Next.js Releases) и читай release notes — так растёт системное понимание экосистемы.
4. Раз в квартал перечитывай раздел Concepts в [Kubernetes Docs](https://kubernetes.io/docs/concepts/) — на каждом уровне понимания открывается новое.

## Что почитать

- [roadmap.sh/full-stack](https://roadmap.sh/full-stack) — общая карта fullstack-пути.
- [roadmap.sh/devops](https://roadmap.sh/devops) — карта DevOps-этапа.
- [MDN Web Docs](https://developer.mozilla.org) — справочник по веб-платформе.
