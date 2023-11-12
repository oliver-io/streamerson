resource "google_storage_bucket" "streamerson_benchmarks" {
  name          = "streamerson-benchmarks"
  location      = "US"
  force_destroy = true

  versioning {
    enabled = false
  }

  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type = "Delete"
    }
  }
}
#
#output "bucket_name" {
#  value = google_storage_bucket.streamerson_benchmarks.name
#}
