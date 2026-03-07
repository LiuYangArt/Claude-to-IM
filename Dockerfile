FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY README.md ./README.md
COPY README.zh-CN.md ./README.zh-CN.md
COPY LICENSE ./LICENSE
COPY config/prompts ./config/prompts

ENV NODE_ENV=production

CMD ["npm", "run", "example:discord"]
