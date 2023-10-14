#!/usr/bin/env bash
RUNNER=$1
TARGET=$2

echo "Running benchmark with $RUNNER for target: $TARGET"
## find a directory with the name of the target:
DIR=$(find . -type d -name $TARGET)

## if the directory exists, run the benchmark:
if [ -d "$DIR" ]; then
    echo "Running benchmark for $TARGET"
    $RUNNER $DIR/benchmark
else
    echo "No benchmark found for $TARGET"
    exit 1
fi
```
