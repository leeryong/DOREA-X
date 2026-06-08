FROM rust:1.91-bookworm AS rhwp-source

ARG RHWP_REPOSITORY=https://github.com/edwardkim/rhwp.git
# Pinned to the same commit dorea-x uses (v0.7.x line). Bump together with
# @rhwp/editor in frontend/package.json.
ARG RHWP_REF=a9dcdee32b17a7f9a20c609a5ed547e62fb8ebae

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --filter=blob:none --no-checkout "$RHWP_REPOSITORY" rhwp \
    && cd rhwp \
    && git fetch --depth 1 origin "$RHWP_REF" \
    && git checkout FETCH_HEAD

RUN cargo install wasm-pack --locked

WORKDIR /src/rhwp
RUN wasm-pack build --target web
RUN wasm-pack build --target nodejs --out-dir pkg-node

# Studio-only patches applied AFTER wasm builds so they don't invalidate the
# Rust build cache. Two patches:
#   1. rhwp-insert-text.patch — exposes a single `insertText` case on the
#      iframe postMessage handler so chat-driven text injection works.
#   2. rhwp-validation-autofix.patch — bypasses a blocking validation modal
#      that hangs loadFile() on pkg-node generated HWPX (no measureTextWidth).
COPY patches/rhwp-insert-text.patch /tmp/rhwp-insert-text.patch
COPY patches/rhwp-validation-autofix.patch /tmp/rhwp-validation-autofix.patch
RUN cd /src/rhwp \
    && git apply /tmp/rhwp-insert-text.patch \
    && git apply /tmp/rhwp-validation-autofix.patch

FROM node:22-bookworm-slim AS studio-builder

WORKDIR /src/rhwp
COPY --from=rhwp-source /src/rhwp /src/rhwp

WORKDIR /src/rhwp/rhwp-studio
RUN npm install
RUN npm run build -- --base=/rhwp/

FROM node:22-bookworm-slim

WORKDIR /app
COPY server.mjs /app/server.mjs
COPY --from=studio-builder /src/rhwp/rhwp-studio/dist /app/public/rhwp
COPY --from=rhwp-source /src/rhwp/pkg-node /app/rhwp/pkg-node

EXPOSE 7700

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7700/rhwp/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/server.mjs"]
