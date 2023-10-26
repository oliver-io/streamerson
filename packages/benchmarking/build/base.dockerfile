FROM node:20.7.0-bullseye-slim
WORKDIR /app

RUN addgroup --system streamerson && adduser --system --group streamerson

COPY dist/packages/benchmarking benchmarking
COPY packages/benchmarking/.env benchmarking/.env
COPY packages/benchmarking/tools/start-benchmark.sh benchmarking/tools/start-benchmark.sh

RUN chown -R streamerson:streamerson .

WORKDIR /app/benchmarking

RUN npm install --production
