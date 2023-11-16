module "redis" {
  restart_policy  = "Always"
  machine_type    = local.redis_machine_type
  instance_name   = "redis"
  source          = "./modules/gce"
  image           = local.redis_image
  privileged_mode = true
  activate_tty    = true
}
