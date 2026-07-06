# Yahtzee Duel — production image. Node + ws only; no build step.
FROM node:22-alpine

WORKDIR /app

# Install only the single runtime dependency (ws) from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (server.js, public/, solver/, strategy.bin, …).
COPY . .

# Fly routes to this internal port; server.js reads PORT.
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
