# server/Dockerfile
FROM node:18-alpine

WORKDIR /app

# Your package.json is in the repo root (not server/)
COPY package*.json ./
RUN npm ci --omit=dev

# Now copy the app source from server/
COPY server/ .

ENV NODE_ENV=production
# Render sets PORT; make sure Server.js uses process.env.PORT || 3000
EXPOSE 3000
CMD ["node", "Server.js"]
