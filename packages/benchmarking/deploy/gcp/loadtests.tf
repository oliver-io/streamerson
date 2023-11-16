#locals {
#  loadtest_image_type = "n1-standard-8"
#}
#
#module "fastify_loadtest_small" {
#  count           = local.enable_small_loadtest
#  machine_type    = local.loadtest_image_type
#  depends_on      = [module.fastify_gateway, module.fastify_microservice]
#  instance_name   = "fastify-loadtest-small"
#  source          = "./modules/gce"
#  image           = local.loadtesting_image
#  restart_policy  = "Never"
#  privileged_mode = true
#  activate_tty    = true
#  env_variables   = {
#    STREAMERSON_BENCHMARK_DIRECTORY   = "loadtests"
#    STREAMERSON_BENCHMARK_FILE_TARGET = "small"
#    STREAMERSON_GATEWAY_HOST          = "http://${module.fastify_gateway.hostname}:${local.gateway_port}"
#    STREAMERSON_REPORT_PRESIGNED_URL  = local.presigned_url_small_fastify
#    MULTICORE                         = 1
#    ARTILLERY_WORKERS                 = 8
#  }
#}
#
#module "fastify_loadtest_large" {
#  count           = local.enable_large_loadtest
#  machine_type    = local.loadtest_image_type
#  depends_on      = [module.fastify_gateway, module.fastify_microservice]
#  instance_name   = "fastify-loadtest-large"
#  source          = "./modules/gce"
#  image           = local.loadtesting_image
#  restart_policy  = "Never"
#  privileged_mode = true
#  activate_tty    = true
#  env_variables   = {
#    STREAMERSON_BENCHMARK_DIRECTORY   = "loadtests"
#    STREAMERSON_BENCHMARK_FILE_TARGET = "large"
#    STREAMERSON_GATEWAY_HOST          = "http://${module.fastify_gateway.hostname}:${local.gateway_port}"
#    STREAMERSON_REPORT_PRESIGNED_URL  = local.presigned_url_large_fastify
#    MULTICORE                         = 1
#    ARTILLERY_WORKERS                 = 8
#  }
#}
#
#module "fastify_loadtest_huge" {
#  count           = local.enable_huge_loadtest
#  machine_type    = local.loadtest_image_type
#  depends_on      = [module.fastify_gateway, module.fastify_microservice]
#  instance_name   = "fastify-loadtest-huge"
#  source          = "./modules/gce"
#  image           = local.loadtesting_image
#  restart_policy  = "Never"
#  privileged_mode = true
#  activate_tty    = true
#  env_variables   = {
#    STREAMERSON_BENCHMARK_DIRECTORY   = "loadtests"
#    STREAMERSON_BENCHMARK_FILE_TARGET = "huge"
#    STREAMERSON_GATEWAY_HOST          = "http://${module.fastify_gateway.hostname}:${local.gateway_port}"
#    STREAMERSON_REPORT_PRESIGNED_URL  = local.presigned_url_huge_fastify
#    MULTICORE                         = 1
#    ARTILLERY_WORKERS                 = 8
#  }
#}
#
#module "streamerson_loadtest_small" {
#  count           = local.enable_small_loadtest
#  machine_type    = local.loadtest_image_type
#  depends_on      = [module.gateway, module.microservice]
#  instance_name   = "streamerson-loadtest-small"
#  source          = "./modules/gce"
#  image           = local.loadtesting_image
#  restart_policy  = "Never"
#  privileged_mode = true
#  activate_tty    = true
#  env_variables   = {
#    STREAMERSON_BENCHMARK_DIRECTORY   = "loadtests"
#    STREAMERSON_BENCHMARK_FILE_TARGET = "small"
#    STREAMERSON_GATEWAY_HOST          = "http://${module.gateway.hostname}:${local.gateway_port}"
#    STREAMERSON_REPORT_PRESIGNED_URL  = local.presigned_url_small_streamerson
#    MULTICORE                         = 1
#    ARTILLERY_WORKERS                 = 8
#  }
#}
#
#module "streamerson_loadtest_large" {
#  count           = local.enable_large_loadtest
#  machine_type    = local.loadtest_image_type
#  depends_on      = [module.gateway, module.microservice]
#  instance_name   = "streamerson-loadtest-large"
#  source          = "./modules/gce"
#  image           = local.loadtesting_image
#  restart_policy  = "Never"
#  privileged_mode = true
#  activate_tty    = true
#  env_variables   = {
#    STREAMERSON_BENCHMARK_DIRECTORY   = "loadtests"
#    STREAMERSON_BENCHMARK_FILE_TARGET = "large"
#    STREAMERSON_GATEWAY_HOST          = "http://${module.gateway.hostname}:${local.gateway_port}"
#    STREAMERSON_REPORT_PRESIGNED_URL  = local.presigned_url_large_streamerson
#    MULTICORE                         = 1
#    ARTILLERY_WORKERS                 = 8
#  }
#}
#
#module "streamerson_loadtest_huge" {
#  count           = local.enable_huge_loadtest
#  machine_type    = local.loadtest_image_type
#  depends_on      = [module.gateway, module.microservice]
#  instance_name   = "streamerson-loadtest-huge"
#  source          = "./modules/gce"
#  image           = local.loadtesting_image
#  restart_policy  = "Never"
#  privileged_mode = true
#  activate_tty    = true
#  env_variables   = {
#    STREAMERSON_BENCHMARK_DIRECTORY   = "loadtests"
#    STREAMERSON_BENCHMARK_FILE_TARGET = "huge"
#    STREAMERSON_GATEWAY_HOST          = "http://${module.gateway.hostname}:${local.gateway_port}"
#    STREAMERSON_REPORT_PRESIGNED_URL  = local.presigned_url_huge_streamerson
#    MULTICORE                         = 1
#    ARTILLERY_WORKERS                 = 8
#  }
#}
