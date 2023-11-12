locals {
  instance_name = format("%s-%s", var.instance_name, substr(md5(var.image), 0, 8))
  env_variables = [
    for var_name, var_value in var.env_variables : {
      name  = var_name
      value = var_value
    }
  ]
}

module "gce-container" {
  # https://github.com/terraform-google-modules/terraform-google-container-vm
  source  = "terraform-google-modules/container-vm/google"
  version = "~> 2.0"

  container = {
    image           = var.image
    env             = local.env_variables
    securityContext = {
      privileged : var.privileged_mode
    }
    tty : var.activate_tty
  }

  restart_policy = (var.restart_policy == "Never" ? null : var.restart_policy)
}

resource "google_compute_disk" "gcp_disk" {
  image                     = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-109-17800-66-15"
  name                      = local.instance_name
  physical_block_size_bytes = "4096"
  project                   = "streamerson-benchmarks"
  provisioned_iops          = "0"
  size                      = "10"
  type                      = "pd-standard"
  zone                      = var.zone
}

resource "google_compute_instance" "gcp_image" {
  boot_disk {
    auto_delete = "true"
    device_name = "persistent-disk-0"
    mode        = "READ_WRITE"
    source      = google_compute_disk.gcp_disk.id
  }

  can_ip_forward      = "false"
  deletion_protection = "false"
  enable_display      = "false"

  labels = {
    container-vm = "cos-stable-109-17800-66-15"
  }

  machine_type = var.machine_type

  metadata = {
    gce-container-declaration = module.gce-container.metadata_value
    google-logging-enabled    = "true"
    startup-script            = "ulimit -n 65535 && sysctl vm.overcommit_memory=1"
  }

  name = local.instance_name

  network_interface {
    access_config {
      network_tier = var.network_tier
    }

    network            = "default"
    queue_count        = "0"
    stack_type         = "IPV4_ONLY"
  }

  #  project = "streamerson-benchmarks"

  scheduling {
    automatic_restart   = var.restart_policy == "Never" ? "false" : "true"
    min_node_cpus       = "0"
    on_host_maintenance = "MIGRATE"
    preemptible         = "false"
    provisioning_model  = "STANDARD"
  }

  service_account {
    email  = "513571045319-compute@developer.gserviceaccount.com"
    scopes = [
      "https://www.googleapis.com/auth/devstorage.read_only",
      "https://www.googleapis.com/auth/logging.write",
      "https://www.googleapis.com/auth/monitoring.write",
      "https://www.googleapis.com/auth/pubsub",
      "https://www.googleapis.com/auth/service.management.readonly",
      "https://www.googleapis.com/auth/servicecontrol",
      "https://www.googleapis.com/auth/trace.append"
    ]
  }

  shielded_instance_config {
    enable_integrity_monitoring = "true"
    enable_secure_boot          = "false"
    enable_vtpm                 = "true"
  }

  tags = var.tags
  zone = var.zone
}
