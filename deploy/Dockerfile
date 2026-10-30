# maniac-duo's relay and browser client, for a server. deploy.sh builds it from
# the committed tree (git archive), so no ROM, and nothing derived from one, is
# ever in the build context.
FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:web

FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
# The server makes ./data at start; the games database lives on the volume.
RUN mkdir -p /app/data /data && chown bun:bun /app/data /data
USER bun
ENV PORT=8787 DB_PATH=/data/games.sqlite
EXPOSE 8787
CMD ["bun", "src/server/main.ts"]
