FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY accounts.json.example ./accounts.json

EXPOSE 3001

CMD ["node", "server.js"]
