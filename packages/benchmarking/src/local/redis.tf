resource "docker_image" "redis" {
    name         = "redis"
    keep_locally = false
}

resource "docker_container" "redis" {
    image = docker_image.redis.image_id
    name  = "terraform-redis"

    ports {
        internal = 6379
        external = 6379
    }
}