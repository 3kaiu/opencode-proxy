FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json ./
RUN bun install --omit=dev
COPY shared/ ./shared/
COPY gcp-cloud-run/ ./gcp-cloud-run/

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app /app
EXPOSE 8080
CMD ["bun", "run", "gcp-cloud-run/index.ts"]