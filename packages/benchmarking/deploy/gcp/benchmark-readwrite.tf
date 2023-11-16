module "client-read" {
  count           = local.enable_readwrite_client_benchmark
  depends_on      = [module.redis]
  restart_policy  = "Always"
  machine_type    = local.microservice_machine_type
  instance_name   = "client-read"
  source          = "./modules/gce"
  image           = local.benchmarking_image
  privileged_mode = true
  activate_tty    = true
  env_variables   = {
    STREAMERSON_REDIS_HOST              = module.redis.hostname
    STREAMERSON_BENCHMARK_DIRECTORY     = "core_modules"
    STREAMERSON_BENCHMARK_FILE_TARGET   = "read-client"
    STREAMERSON_BENCHMARK_PROJECT       = "streamerson"
    STREAMERSON_ENVIRONMENT_CLOUD       = true
    STREAMERSON_LOG_LEVEL               = "debug"
    PINO_LOG_LEVEL                      = "debug"
    STREAMERSON_BENCHMARK_MESSAGE_COUNT = 100000
    STREAMERSON_BENCHMARK_BATCH_SIZE    = 10
    STREAMERSON_REPORT_PRESIGNED_URL    = local.presigned_url_read_benchmark_client
  }
}

module "streamerson-read" {
  count           = local.enable_readwrite_streamerson_benchmark
  depends_on      = [module.redis]
  restart_policy  = "Always"
  machine_type    = local.microservice_machine_type
  instance_name   = "streamerson-read"
  source          = "./modules/gce"
  image           = local.benchmarking_image
  privileged_mode = true
  activate_tty    = true
  env_variables   = {
    STREAMERSON_REDIS_HOST              = module.redis.hostname
    STREAMERSON_BENCHMARK_DIRECTORY     = "core_modules"
    STREAMERSON_BENCHMARK_FILE_TARGET   = "read-framework"
    STREAMERSON_BENCHMARK_PROJECT       = "streamerson"
    STREAMERSON_ENVIRONMENT_CLOUD       = true
    STREAMERSON_LOG_LEVEL               = "debug"
    PINO_LOG_LEVEL                      = "debug"
    STREAMERSON_BENCHMARK_MESSAGE_COUNT = 100000
    STREAMERSON_BENCHMARK_BATCH_SIZE    = 10
    STREAMERSON_REPORT_PRESIGNED_URL    = local.presigned_url_read_benchmark_framework
  }
}
