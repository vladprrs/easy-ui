#!/usr/bin/env bash
# Запуск Claude Code с конфигом из директории проекта (авторизация уже скопирована)
CLAUDE_CONFIG_DIR=/home/coder/project/.claude-config exec claude "$@"
