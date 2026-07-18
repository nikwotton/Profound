FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY infra ./infra
COPY scripts ./scripts
COPY src ./src
COPY tests ./tests
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime

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
