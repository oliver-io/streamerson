#!/usr/bin/env bash
RUNNER="${1:-node}"
TARGET="${2:-$STREAMERSON_BENCHMARK_DIRECTORY}"
SCRIPT="${3:-$STREAMERSON_BENCHMARK_FILE_TARGET}"
CLOUD="${4:-$STREAMERSON_ENVIRONMENT_CLOUD}"
CLOUD_URL="${5:-$STREAMERSON_REPORT_PRESIGNED_URL}"
echo "Running benchmark with $RUNNER for target: $TARGET ($SCRIPT)"

## find a directory with the name of the target:
DIR=$(find . -type d -name $TARGET)

## debug stuff:

## if the directory exists, run the benchmark:
if [ -d "$DIR" ]; then
    echo "Running benchmark for $TARGET (\"$RUNNER $DIR/$SCRIPT\") ..."
    $RUNNER $DIR/$SCRIPT
    # if the cloud param is not empty, upload the results:
    if [ -n "$CLOUD" ]; then
        echo "Uploading results to cloud ($CLOUD) ..."
        curl -X PUT -H 'Content-Type: application/json' --upload-file /app/benchmarking/benchmark-report.json "$CLOUD_URL"
    fi
else
    echo "No benchmark found for $TARGET"
    exit 1
fi
