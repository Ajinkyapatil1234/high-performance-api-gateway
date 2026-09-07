FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

EXPOSE 3000 4000

CMD ["node", "dist/server.js"]
