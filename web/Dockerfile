FROM node:18-alpine

WORKDIR /app

COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY server ./server
COPY client/dist ./client/dist

WORKDIR /app/server

EXPOSE 3001

CMD ["node", "index.js"]
