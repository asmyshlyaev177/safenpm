#!/bin/sh
set -e

echo "[ringfence-macos-test] starting dockerd..."
dockerd &
DOCKERD_PID=$!

echo "[ringfence-macos-test] waiting for Docker daemon..."
until docker ps >/dev/null 2>&1; do
    if ! kill -0 "$DOCKERD_PID" 2>/dev/null; then
        echo "[ringfence-macos-test] ERROR: dockerd died unexpectedly"
        exit 1
    fi
    sleep 1
done

echo "[ringfence-macos-test] pulling Docker images..."
docker pull node:lts
docker pull oven/bun:latest

echo "[ringfence-macos-test] running macOS sandbox comprehensive tests..."
node --experimental-strip-types --test tests/comprehensive-macos.test.ts
EXIT_CODE=$?

echo "[ringfence-macos-test] tests finished with exit code $EXIT_CODE"
exit $EXIT_CODE
