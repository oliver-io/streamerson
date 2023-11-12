FROM artilleryio/artillery:latest

WORKDIR /app
COPY dist/packages/benchmarking benchmarking

VOLUME /tmp:/tmp
RUN apk update && apk add curl
WORKDIR /app/benchmarking

# Copy in the things that we don't actually build with Typescript:
COPY packages/benchmarking/.env /app/benchmarking/.env
COPY packages/benchmarking/src/loadtests/artillery/small.yaml /app/benchmarking/src/loadtests/artillery/small.yaml

#ENTRYPOINT run run  --output /tmp/report.json /app/benchmarking/src/loadtests/artillery/small.yaml
ENTRYPOINT sh -c "\
run run --output /tmp/report.json /app/benchmarking/src/loadtests/artillery/small.yaml \
&& curl -X PUT -H 'Content-Type: application/json' --upload-file /tmp/report.json '$STREAMERSON_REPORT_PRESIGNED_URL'"

