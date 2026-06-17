FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/seat-service/package.json apps/seat-service/package.json
RUN npm install
COPY . .
RUN npm run build -w @seat/shared && npm run build -w @seat/seat-service

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
CMD ["sh", "-c", "node scripts/migrate.mjs seat && node apps/seat-service/dist/index.js"]
