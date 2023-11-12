module "loadtest" {
  machine_type    = "n1-standard-1"
  depends_on      = [module.gateway, module.microservice]
  instance_name   = "loadtest"
  source          = "./modules/gce"
  image           = local.loadtesting_image
  privileged_mode = true
  activate_tty    = true
  env_variables   = {
    STREAMERSON_BENCHMARK_DIRECTORY   = "loadtests"
    STREAMERSON_BENCHMARK_FILE_TARGET = "small"
    STREAMERSON_GATEWAY_HOST          = "http://${module.gateway.hostname}:${local.gateway_port}"
    STREAMERSON_REPORT_PRESIGNED_URL  = local.presigned_url
  }
}
