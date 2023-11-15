module "gateway" {
  restart_policy  = "Always"
  instance_name   = "gateway"
  machine_type    = local.gateway_machine_type
  source          = "./modules/gce"
  image           = local.benchmarking_image
  privileged_mode = true
  activate_tty    = true
  env_variables   = {
    STREAMERSON_REDIS_HOST            = module.redis.hostname
    STREAMERSON_GATEWAY_PORT          = local.gateway_port
    STREAMERSON_BENCHMARK_DIRECTORY   = "loadtests"
    STREAMERSON_BENCHMARK_FILE_TARGET = "streamerson-gateway"
    STREAMERSON_LOG_LEVEL             = "debug"
    PINO_LOG_LEVEL                    = "debug"
  }
}
