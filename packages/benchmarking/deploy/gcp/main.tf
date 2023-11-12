locals {
  project = "streamerson-benchmarks"
}

terraform {
    required_providers {
        google = {
            source = "hashicorp/google"
            version = "4.51.0"
        }
    }
}

provider "google" {
    credentials = file("key.GCP.json")
    project = local.project
    region  = "us-central1"
    zone    = "us-central1-c"
}
