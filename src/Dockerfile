# Client (React) dev server
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better caching)
COPY package*.json ./
RUN npm ci

# Copy the rest of the app
COPY . .

ENV HOST=0.0.0.0
ENV PORT=3000
ENV REACT_APP_API_BASE=http://localhost:5000

EXPOSE 3000

# CRA dev server (hot reload)
CMD ["npm", "start"]
