terraform {
    required_providers {
        google = {
            source = "hashicorp/google"
            version = "4.51.0"
        }
    }
}

provider "google" {
    credentials = file("<NAME>.json")

    project = "<PROJECT_ID>"
    region  = "us-central1"
    zone    = "us-central1-c"
}

resource "google_compute_network" "vpc_network" {
    name = "terraform-network"
}