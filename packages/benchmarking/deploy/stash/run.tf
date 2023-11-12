locals {
  redis_host = "redis-10651.c259.us-central1-2.gce.cloud.redislabs.com"
}

resource "google_vpc_access_connector" "connector" {
  name          = "streamerson-vpc"
  ip_cidr_range = "10.8.0.0/28"
  network       = "default"
}

resource "google_cloud_run_v2_job" "microservice" {
  depends_on = [google_vpc_access_connector.connector]
  name       = "streamerson-benchmark-microservice-job"
  location   = "us-central1"

  template {
    template {
      vpc_access {
        egress = "ALL_TRAFFIC"
        connector       = google_vpc_access_connector.connector.id
      }
      containers {
        image = "docker.io/0liveri0/streamerson-microservice:latest"
        env {
          name  = "STREAMERSON_GATEWAY_PORT"
          value = "8080"
        }
        env {
          name  = "STREAMERSON_REDIS_HOST"
          value = local.redis_host
        }
        env {
          name  = "STREAMERSON_MICROSERVICE_PORT"
          value = "8081"
        }
        env {
          name  = "STREAMERSON_BENCHMARK_DIRECTORY"
          value = "loadtests"
        }
        env {
          name  = "STREAMERSON_BENCHMARK_FILE_TARGET"
          value = "streamerson-microservice"
        }
        env {
          name  = "STREAMERSON_BENCHMARK_REPORT_PATH"
          value = "/app/benchmarks"
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      launch_stage,
    ]
  }
}


resource "google_cloud_run_v2_job" "redis" {
  depends_on = [google_vpc_access_connector.connector]
  name       = "streamerson-benchmark-redis"
  location   = "us-central1"

  template {
    template {
      vpc_access {
        egress = "ALL_TRAFFIC"
        connector       = google_vpc_access_connector.connector.id
      }
      containers {
        image = "docker.io/redis:latest"
      }
    }
  }

  lifecycle {
    ignore_changes = [
      launch_stage,
    ]
  }
}
