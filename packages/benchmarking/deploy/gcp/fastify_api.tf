#module "fastify_gateway" {
#  depends_on = [
#    module.fastify_microservice
#  ]
#  restart_policy  = "Always"
#  instance_name   = "fastify-gateway"
#  machine_type    = local.gateway_machine_type
#  source          = "./modules/gce"
#  image           = local.benchmarking_image
#  privileged_mode = true
#  activate_tty    = true
#  env_variables   = {
#    STREAMERSON_BENCHMARK_DIRECTORY   = "loadtests"
#    STREAMERSON_BENCHMARK_FILE_TARGET = "fastify-gateway"
#    STREAMERSON_GATEWAY_PORT          = local.gateway_port
#    STREAMERSON_MICROSERVICE_HOST     = module.fastify_microservice.hostname
#    STREAMERSON_MICROSERVICE_PORT     = local.microservice_port
#  }
#}
