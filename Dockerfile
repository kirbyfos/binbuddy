FROM node:20-alpine

WORKDIR /app

# Install dependencies (root + server)
COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json ./server/
RUN npm ci
RUN npm --prefix server ci

# Copy the rest of the app
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]

