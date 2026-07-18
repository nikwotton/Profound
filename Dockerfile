FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS build

ARG INCLUDE_DEV_TOOLS=false

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm --filter . install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json tsconfig.dev-build.json ./
COPY infra ./infra
COPY scripts ./scripts
COPY src ./src
RUN if [ "$INCLUDE_DEV_TOOLS" = "true" ]; then pnpm build:dev; else pnpm build; fi \
    && pnpm prune --prod

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS runtime

ENV NODE_ENV=production
WORKDIR /app

# The runtime invokes Node directly; omit npm and its dependency tree from the
# final image so build-only package-manager vulnerabilities are not deployable.
RUN npm uninstall --global npm

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src

USER node
EXPOSE 1080 8080 8081 8082 8083 8090 8091
CMD ["node", "dist/src/index.js"]
