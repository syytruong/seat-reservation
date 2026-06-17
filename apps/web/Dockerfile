FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm install
COPY apps/web apps/web
USER node
WORKDIR /app/apps/web
CMD ["npm", "run", "start"]
