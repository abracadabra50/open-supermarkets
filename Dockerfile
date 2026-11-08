FROM node:24-slim

WORKDIR /app

ENV GROC_API_HOST=127.0.0.1
ENV GROC_API_PORT=7876

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

EXPOSE 7876
CMD ["npm", "run", "api"]
