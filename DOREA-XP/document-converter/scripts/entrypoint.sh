#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-serve}" == "serve" ]]; then
  exec uvicorn src.main:app --host 0.0.0.0 --port 8003
fi

exec /usr/local/bin/document-converter "$@"
