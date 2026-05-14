# ringfence test runner — runs the full test suite inside a clean Docker
# container so planted host secrets (.env, .ssh, .aws) are created in a
# disposable environment and removed when the container exits.
#
# Build & run:
#   docker build -t ringfence-test -f tests/Dockerfile .
#   docker run --rm --privileged ringfence-test

FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap \
    ca-certificates \
    zsh \
    && rm -rf /var/lib/apt/lists/*

# Install additional package managers for cross-PM testing
RUN npm install -g pnpm bun --force

WORKDIR /ringfence

# Root dependencies (cached separately from source changes)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --no-frozen-lockfile --ignore-scripts

# Copy remaining source
COPY . .

# Build the ringfence bundles
RUN pnpm build

RUN ./install.sh

ENV PATH="/root/.ringfence/bin:${PATH}"

# Run root tests (login shell so .profile sets PATH)
CMD ["/bin/bash", "-lc", "pnpm run test"]
