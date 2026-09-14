FROM node:24.20.0-bookworm-slim

# 接收构建参数
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG http_proxy
ARG https_proxy

RUN npm install -g pnpm@11.24.0

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile

RUN cp ./.env.example ./.env

RUN pnpm exec tsc --noEmit

RUN pnpm prune --prod

ENV PANTHEON_HOST=0.0.0.0

EXPOSE 3000

ENTRYPOINT ["pnpm", "run", "start"]

# docker build --build-arg HTTP_PROXY="http://host.docker.internal:7897" --build-arg HTTPS_PROXY="http://host.docker.internal:7897" -t deliveryperson2004/deep-forge .
