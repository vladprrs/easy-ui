#!/usr/bin/env bash
set -euo pipefail

# Keep this project's Codex config, plugins, MCP servers, skills, and sessions
# separate from ~/.codex. Reuse only the existing login on first launch.
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_CODEX_HOME="${PROJECT_DIR}/.codex-home"
GLOBAL_AUTH_FILE="${HOME}/.codex/auth.json"

mkdir -p "${PROJECT_CODEX_HOME}"

if [[ ! -e "${PROJECT_CODEX_HOME}/auth.json" && -f "${GLOBAL_AUTH_FILE}" ]]; then
  cp "${GLOBAL_AUTH_FILE}" "${PROJECT_CODEX_HOME}/auth.json"
  chmod 600 "${PROJECT_CODEX_HOME}/auth.json"
fi

export CODEX_HOME="${PROJECT_CODEX_HOME}"
exec codex -C "${PROJECT_DIR}" "$@"
