# safenpm test runner — runs the full test suite inside a clean Docker
# container so planted host secrets (.env, .ssh, .aws) are created in a
# disposable environment and removed when the container exits.
#
# Build & run:
#   docker build -t safenpm-test -f tests/Dockerfile .
#   docker run --rm --privileged safenpm-test

FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap \
    ca-certificates \
    zsh \
    && rm -rf /var/lib/apt/lists/*

# Install additional package managers for cross-PM testing
RUN npm install -g pnpm bun --force

WORKDIR /safenpm

# Root dependencies (cached separately from source changes)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --no-frozen-lockfile --ignore-scripts

# Copy remaining source
COPY . .

# Build the safenpm bundles
RUN pnpm build

# Install site dependencies (Astro, Tailwind)
RUN cd site && pnpm install --no-frozen-lockfile --ignore-scripts

# Run root tests then site tests
CMD ["sh", "-c", "pnpm run test && cd site && pnpm test"]
