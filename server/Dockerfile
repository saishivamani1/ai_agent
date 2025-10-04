FROM node:20-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

EXPOSE 5000

# Use dynamic PORT from Render
CMD ["node", "Server.js"]
