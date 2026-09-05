FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.html ./
COPY server ./server
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/server.js"]
