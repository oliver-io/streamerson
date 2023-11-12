output "hostname" {
  value = google_compute_instance.gcp_image.network_interface[0].network_ip
}
