---
title: "Инструментарий разработчика на Arch Linux"
description: "Проверенный софт для разработки на Arch: редакторы, терминал, TUI-утилиты, команды pacman/yay, dotfiles, Dev Containers и Nix."
---

Arch Linux — идеальная платформа для разработчика: bleeding-edge пакеты, полный контроль, минималистичная основа. Это приложение — подборка проверенного софта и плагинов с командами установки. Ставь не всё сразу: начни с базы (редактор, терминал, git, docker), остальное добавляй по мере необходимости.

## Базовая установка

AUR-хелпер понадобится для софта вне официальных репозиториев:

```bash
# База для сборки из AUR
sudo pacman -S --needed git base-devel

# yay — самый популярный AUR-хелпер
git clone https://aur.archlinux.org/yay.git
cd yay
makepkg -si
```

Основной софт одной командой:

```bash
sudo pacman -S \
  git github-cli \
  docker docker-compose \
  nodejs npm pnpm \
  neovim vim \
  kitty tmux zsh fish \
  btop htop \
  fd ripgrep fzf eza zoxide \
  lazygit lazydocker \
  dbeaver \
  firefox-developer-edition \
  noto-fonts-emoji ttf-jetbrains-mono
```

Из AUR:

```bash
yay -S \
  visual-studio-code-bin \
  bruno-bin \
  jetbrains-mono-nerd-fonts ttf-fira-code-nerd \
  postman-bin insomnia-bin
```

Включение Docker:

```bash
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
# Перелогинься, чтобы группа применилась
```

:::caution[Перелогин после usermod]
Группа `docker` применяется только при новой сессии. Если команда `docker ps` ругается на permission denied — выйди и зайди снова, а не запускай от `sudo` (это ломает права на сокет).
:::

## Редакторы кода

### VS Code / VS Codium

VS Codium — open-source сборка VS Code без телеметрии. Плагины must-have:

- `ESLint`, `Prettier` — линтинг и форматирование.
- `Tailwind CSS IntelliSense` — автокомплит классов.
- `Error Lens` — ошибки прямо в строке.
- `GitLens` — мощная визуализация Git.
- `Docker` — управление контейнерами из IDE.
- `Thunder Client` / `REST Client` — тестирование API.
- `Prisma` — поддержка схем и SQL.
- `Remote - SSH` — разработка на VPS прямо из редактора.
- `Markdown All in One`, `MDX` — документация.
- `GitHub Copilot` / `Codeium` — AI-автодополнение.

Темы: `Catppuccin`, `Tokyo Night`, `Dracula Official`. Шрифт в редакторе и терминале — **JetBrains Mono Nerd Font** или **Fira Code Nerd Font** (лигатуры + иконки).

### Neovim

Для тех, кто хочет максимальную скорость работы без отрыва рук от клавиатуры:

- Дистрибутивы: **LazyVim**, **AstroNvim**, **NvChad** — готовые конфиги, не собирай свой с нуля на первом году.
- LSP-серверы: `typescript-language-server`, `tailwindcss-language-server`, `prisma-language-server`, `eslint-lsp`.
- Форматтеры: `prettierd`, `sqlfluff`.
- Файловый менеджер: `nvim-tree` или `oil.nvim`.

:::tip[Не религия]
VS Code и Neovim — инструменты, а не вера. Многие инженеры используют оба: Neovim для быстрых правок в терминале, VS Code для отладки и рефакторингов. Начни с VS Code, Neovim добавь, когда руки сами попросят скорости.
:::

## Терминал и Shell

```bash
# Эмулятор терминала — выбери один
sudo pacman -S kitty            # GPU-ускорение, лигатуры
sudo pacman -S alacritty        # минимализм на Rust
yay -S wezterm-bin              # GPU + встроенный мультиплексор

# Мультиплексор: сессии и панели
sudo pacman -S tmux             # классика
sudo pacman -S zellij           # современный, из коробки

# Shell
sudo pacman -S zsh fish
# zsh: oh-my-zsh / zinit + powerlevel10k
# fish: автоподсказки и синтаксис из коробки

# Промпт — кроссшелловый и быстрый
sudo pacman -S starship

# TUI-файловый менеджер
sudo pacman -S yazi             # предпросмотр, мультиплекс
```

## Разработка и DevOps

```bash
# Git в терминале: визуальные ветки, интерактивный rebase
sudo pacman -S lazygit

# Docker в терминале: контейнеры, образы, логи
sudo pacman -S lazydocker

# API-клиент (open-source, коллекции в Git)
yay -S bruno-bin

# Базы данных (GUI)
sudo pacman -S dbeaver           # универсальный: PostgreSQL, MySQL, Redis...

# Redis GUI
yay -S another-redis-desktop-manager-bin
```

## Системный мониторинг и утилиты

```bash
sudo pacman -S btop              # системный монитор — красивый и настраиваемый
sudo pacman -S ncdu              # анализ занятого места на диске
sudo pacman -S fd ripgrep fzf    # быстрый find, grep и нечёткий поиск
sudo pacman -S zoxide eza        # умный cd и современный ls с иконками

# Диагностика сети
sudo pacman -S bind tcpdump wireshark-qt
```

Ежедневные замены старого доброго:

```bash
# вместо ls — eza с иконками и деревом
eza -la --icons --git
# вместо find — fd
fd '\.tsx$' src
# вместо grep — rg
rg 'useEffect' src/
# вместо cd — zoxide (учится на твоих привычках)
z proj   # прыгнет в ~/Devops/tmp/fullstack-devops-textbook, если ты там часто бываешь
```

:::note[Привычки меняются за неделю]
Первая неделя с `zoxide` и `eza` покажется непривычной. Через две недели возврат на чистый `cd` и `ls` будет раздражать — значит, утилиты встроились в мышечную память.
:::

## Dotfiles и воспроизводимое окружение

Храни конфиги в Git, чтобы поднять окружение на новой машине за минуты:

```bash
# Структура репозитория dotfiles
mkdir -p ~/dotfiles && cd ~/dotfiles
git init

# Через GNU Stow — симлинки конфигов
sudo pacman -S stow
stow zsh tmux nvim kitty   # создаст симлинки ~/.zshrc, ~/.tmux.conf и т.д.

# Или Chezmoi — с шаблонами и секретами
sudo pacman -S chezmoi
chezmoi init
```

**Dev Containers** — изолируй проекты в контейнерах через VS Code: определи `.devcontainer/devcontainer.json` в репозитории — и любой (включая тебя через полгода) поднимет идентичное окружение одной командой.

## Nix — продвинутый уровень

Nix и Home Manager дают полностью воспроизводимое окружение: одна команда разворачивает тот же набор пакетов и конфигов на любом Linux:

```bash
# Установка Nix (single-user режим для старта)
sh <(curl -L https://nixos.org/nix/install) --no-daemon

# Home Manager — управление пользовательскими конфигами
nix-channel --add https://github.com/nix-community/home-manager/archive/master.tar.gz home-manager
nix-channel --update
nix-shell '<home-manager>' -A install
```

Не берись за Nix в первый месяц пути — это отдельная технология с крутой кривой обучения. Заходи, когда dotfiles через Stow перестанут решать задачу.

## Практика

1. Установи базовый набор (`git`, `nodejs`, `docker`, `kitty`, `zsh`, `starship`, `btop`, `fd`, `ripgrep`, `fzf`, `eza`, `zoxide`, `lazygit`) и настрой `zsh` + Starship.
2. Создай репозиторий `dotfiles`, перенеси туда `~/.zshrc` и `~/.gitconfig` через `stow`, запушь на GitHub.
3. Настрой VS Code с плагинами из списка выше и выстави шрифт JetBrains Mono Nerd Font.
4. Создай `.devcontainer/devcontainer.json` для одного из своих проектов и открой его в контейнере.
5. Поставь `yazi` и `lazydocker` и неделю работай без GUI-файлового менеджера.

## Что почитать

- [Arch Wiki](https://wiki.archlinux.org) — лучшая документация по Linux вообще; каждая утилита из списка там разобрана.
- [Yazi docs](https://yazi-rs.github.io/docs/) — ключи и конфигурация файлового менеджера.
- [Dev Containers specification](https://containers.dev/) — формат `.devcontainer.json`.
- [Home Manager manual](https://nix-community.github.io/home-manager/) — когда доберёшься до Nix.
