#!/usr/bin/env bash
# Project-scoped clean for the Bun toolchain. `postclean` re-runs `bun install && bun run build`.
# (Intentionally does NOT touch unrelated Docker containers/images or the bun.lock.)
set -e
docker compose down -v 2>/dev/null || true
rm -rf node_modules tmp dist packages/*/node_modules
