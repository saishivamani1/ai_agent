# server/Dockerfile
FROM node:22-alpine

WORKDIR /app

# Copy lockfile if present; npm ci needs it
COPY package*.json ./

# If you DO have package-lock.json, use ci:
RUN npm ci --omit=dev
# If you DON'T have package-lock.json, comment the line above and use:
# RUN npm install --omit=dev

# Copy the server sources
COPY server/ .

ENV NODE_ENV=production
# Ensure Server.js listens on process.env.PORT || 3000 and host 0.0.0.0
EXPOSE 3000
CMD ["node", "Server.js"]
