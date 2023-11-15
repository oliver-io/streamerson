module "microservice" {
  restart_policy  = "Always"
  machine_type    = local.microservice_machine_type
  instance_name   = "microservice"
  source          = "./modules/gce"
  image           = local.benchmarking_image
  privileged_mode = true
  activate_tty    = true
  env_variables   = {
    STREAMERSON_REDIS_HOST            = module.redis.hostname
    STREAMERSON_MICROSERVICE_PORT     = local.microservice_port
    STREAMERSON_BENCHMARK_DIRECTORY   = "loadtests"
    STREAMERSON_BENCHMARK_FILE_TARGET = "streamerson-microservice"
    STREAMERSON_LOG_LEVEL             = "debug"
    PINO_LOG_LEVEL                    = "debug"
  }
}
