module "fastify_microservice" {
  restart_policy  = "Always"
  machine_type    = local.microservice_machine_type
  instance_name   = "fastify-microservice"
  source          = "./modules/gce"
  image           = local.benchmarking_image
  privileged_mode = true
  activate_tty    = true
  env_variables   = {
    STREAMERSON_BENCHMARK_DIRECTORY   = "loadtests"
    STREAMERSON_BENCHMARK_FILE_TARGET = "fastify-microservice"
    STREAMERSON_MICROSERVICE_PORT     = local.microservice_port
  }
}
