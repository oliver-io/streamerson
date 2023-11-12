module "redis" {
  restart_policy  = "Always"
  machine_type    = "n1-standard-1"
  instance_name   = "redis"
  source          = "./modules/gce"
  image           = local.redis_image
  privileged_mode = true
  activate_tty    = true
}

#gcloud compute instances create-with-container redis-test --container-image redis:latest --tags redis
