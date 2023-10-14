FROM streamerson/benchmarking:latest
ARG STREAMERSON_BENCHMARK_APP_TARGET
WORKDIR /app/benchmarking
CMD node -e "console.log(require('fs').readdirSync('./tools'))"
CMD ./tools/run-benchmark.sh node $STREAMERSON_BENCHMARK_APP_TARGET
