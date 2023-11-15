FROM artilleryio/artillery:latest

WORKDIR /app
COPY dist/packages/benchmarking benchmarking

RUN apk update && apk add curl
WORKDIR /app/benchmarking

# Copy in the things that we don't actually build with Typescript:
COPY packages/benchmarking/.env /app/benchmarking/.env
COPY packages/benchmarking/src/loadtests/artillery /app/benchmarking/src/loadtests/artillery

ENTRYPOINT sh -c "\
run run --output /tmp/report.json /app/benchmarking/src/loadtests/artillery/$STREAMERSON_BENCHMARK_FILE_TARGET.yaml \
&& curl -X PUT -H 'Content-Type: application/json' --upload-file /tmp/report.json '$STREAMERSON_REPORT_PRESIGNED_URL'"

