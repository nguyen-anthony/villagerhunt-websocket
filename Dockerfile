# Use a small Node image
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src
RUN npm ci
RUN npm run build

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json* /app/dist ./ 
RUN npm ci --production
EXPOSE 4000
CMD ["node", "dist/index.js"]
