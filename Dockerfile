FROM node:20-slim

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./tsconfig.json
COPY tsconfig.build.json ./tsconfig.build.json
COPY src ./src
RUN npm ci

COPY README.md ./README.md
COPY README.zh-CN.md ./README.zh-CN.md
COPY LICENSE ./LICENSE
COPY config/prompts ./config/prompts

ENV NODE_ENV=production

CMD ["npm", "run", "example:discord"]
