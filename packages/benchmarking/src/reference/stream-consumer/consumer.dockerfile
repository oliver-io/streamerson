FROM node:20.7.0-bullseye-slim
WORKDIR /app

RUN addgroup --system gatewaygroup && adduser --system --group gatewaygroup

COPY dist/packages/benchmarking benchmarking
COPY packages/benchmarking/.env benchmarking/.env

RUN chown -R gatewaygroup:gatewaygroup .

WORKDIR /app/benchmarking

RUN npm install --omit=dev --no-cache

CMD ["node", "./src/reference/stream-consumer/consumer"]
