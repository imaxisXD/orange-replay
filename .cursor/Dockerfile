FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl lsof build-essential python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

USER node
