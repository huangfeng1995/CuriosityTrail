FROM node:18-alpine

WORKDIR /app

COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY server ./server
COPY client/dist ./server/public

WORKDIR /app/server

EXPOSE 3001

CMD ["node", "index.js"]
