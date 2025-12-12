# Use a small Node image
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src
RUN ls -la /app
RUN npm ci
RUN npm run build
RUN ls -la /app/dist
RUN npm ci --production
EXPOSE 4000
CMD ["node", "dist/index.js"]
