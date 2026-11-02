# pitbot, pit.world's crawler. Built from the repository root:
#   docker build -f services/crawler/Dockerfile -t pit-crawler .
FROM oven/bun:1.4-slim
WORKDIR /app
COPY package.json bun.lock ./
COPY services/crawler/package.json services/crawler/package.json
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY services/crawler ./services/crawler
# Dev boxes check out with umask 007; the runtime user must still read the code.
RUN chmod -R a+rX /app
ENV NODE_ENV=production CRAWL_HEALTH_PORT=8797
USER bun
# A blocked event loop or a dead Redis shows as unhealthy (watchdog-autoheal restarts it).
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8797/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "services/crawler/src/cli.ts", "worker"]
