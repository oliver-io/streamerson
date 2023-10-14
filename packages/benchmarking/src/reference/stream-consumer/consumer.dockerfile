FROM node:20.7.0-bullseye-slim
WORKDIR /app

RUN addgroup --system streamerson && adduser --system --group streamerson

COPY dist/packages/benchmarking benchmarking
COPY packages/benchmarking/.env benchmarking/.env

RUN chown -R streamerson:streamerson .

WORKDIR /app/benchmarking

RUN npm install --production

CMD ["node", "./src/reference/stream-consumer/consumer"]
