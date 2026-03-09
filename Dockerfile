FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./tsconfig.json
COPY tsconfig.build.json ./tsconfig.build.json
COPY src ./src

RUN npm run build

FROM node:20-slim AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts \
  && npm cache clean --force

FROM gcr.io/distroless/nodejs20-debian12 AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./package.json
COPY config/prompts ./config/prompts

CMD ["dist/lib/bridge/examples/discord-echo-host.js"]
