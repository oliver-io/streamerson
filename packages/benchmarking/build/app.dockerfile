FROM streamerson/benchmarking:latest
WORKDIR /app/benchmarking
CMD node -e "console.log(require('fs').readdirSync('./tools'))"
CMD ./tools/start-benchmark.sh
