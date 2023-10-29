#!/usr/bin/env bash
RUNNER="${1:-node}"
TARGET="${2:-$STREAMERSON_BENCHMARK_DIRECTORY}"
SCRIPT="${3:-$STREAMERSON_BENCHMARK_FILE_TARGET}"
echo "Running benchmark with $RUNNER for target: $TARGET ($SCRIPT)"

## find a directory with the name of the target:
DIR=$(find . -type d -name $TARGET)

## debug stuff:

## if the directory exists, run the benchmark:
if [ -d "$DIR" ]; then
    echo "Running benchmark for $TARGET (\"$RUNNER $DIR/$SCRIPT\") ..."
    set STREAMERSON_LOG_LEVEL=warn
    $RUNNER $DIR/$SCRIPT
else
    echo "No benchmark found for $TARGET"
    exit 1
fi
