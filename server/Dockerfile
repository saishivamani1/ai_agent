# Use official Node.js LTS image
FROM node:18

# Set workdir
WORKDIR /app

# Copy package files & install deps
COPY server/package*.json ./
RUN npm install --production

# Copy rest of the app
COPY server/ .

# Expose port (Express default 3000)
EXPOSE 3000

# Run app
CMD ["node", "Server.js"]
