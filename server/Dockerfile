# server/Dockerfile
FROM node:22-alpine

WORKDIR /app

# Copy package.json (and package-lock.json if it exists)
COPY package*.json ./

# Install only production deps
RUN npm install --omit=dev

# Copy the rest of the server code
COPY server/ .

ENV NODE_ENV=production

# Make sure your Server.js uses process.env.PORT || 3000 and host 0.0.0.0
EXPOSE 3000
CMD ["node", "Server.js"]
