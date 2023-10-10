resource "docker_image" "streamerson-worker" {
    name         = "streamerson-worker"
    keep_locally = false

    build {
        context = "../reference"
        dockerfile = "streamerson-worker.dockerfile"
        tag     = ["streamerson-worker:develop"]
        triggers = {
            dir_sha1 = sha1(join("", [for f in fileset(path.module, "*") : filesha1(f)]))
        }
    }
}

resource "docker_container" "streamerson-worker" {
    image = docker_image.streamerson-worker.image_id
    name  = "streamerson-worker"

    ports {
        internal = 8000
        external = 8000
    }
}

resource "docker_container_network" "streamerson-worker" {
    container_id = docker_container.streamerson-worker.id
    network      = docker_network.streamerson.name
}