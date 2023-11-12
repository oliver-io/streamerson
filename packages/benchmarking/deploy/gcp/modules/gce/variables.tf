variable "network_name" {
  type = string
  default = "default"
}

variable "instance_name" {
  description = "The desired name to assign to the deployed instance"
  default = "disk-instance-vm-test"
}

variable "image" {
  description = "The Docker image to deploy to GCE instances"
}

variable "env_variables" {
  type = map(string)
  default = {}
}

variable "privileged_mode" {
  type = bool
  default = false
}

variable "activate_tty" {
  type = bool
  default = false
}

variable "machine_type" {
  type = string
  default = "f1-micro"
}

variable "network_tier" {
  type = string
  default = "STANDARD"
}

variable "zone" {
  type = string
  default = "us-central1-a"
}

variable "region" {
  type = string
  default = "us-central1"
}

variable "custom_command" {
  type = list(string)
  default = null
}

variable "tags" {
  type = list(string)
  default = null
}

variable "restart_policy" {
  type    = string
  default = "Never"

  validation {
    condition     = contains(["Always", "OnFailure", "Never"], var.restart_policy)
    error_message = "Allowed values for input_parameter are \"Always\" or \"OnFailure\""
  }
}

variable "additional_metadata" {
  type = map(string)
  description = "Additional metadata to attach to the instance"
  default = null
}
