resource "docker_image" "streamerson-gateway" {
    name         = "streamerson-gateway"
    keep_locally = false
    build {
        context = "../reference"
        dockerfile = "streamerson-gateway.dockerfile"
        tag     = ["streamerson-gateway:develop"]
    }
}

resource "docker_container" "streamerson-gateway" {
    image = docker_image.streamerson-gateway.image_id
    name  = "streamerson-gateway"

    ports {
        internal = 8000
        external = 8000
    }
}

resource "docker_container_network" "streamerson-gateway" {
    container_id = docker_container.streamerson-gateway.id
    network      = docker_network.streamerson.name
}