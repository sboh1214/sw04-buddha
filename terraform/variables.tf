# --- account / naming -------------------------------------------------------------------------------

variable "profile" {
  description = "AWS CLI profile used for authentication. Must resolve to the terraform-iam user (never root)."
  type        = string
  default     = "inno-frame"
}

variable "project" {
  description = "Project slug. Drives the tf-<project> resource-name prefix and the Project tag."
  type        = string
  default     = "buddha"
}

variable "environment" {
  description = "Deployment environment. Recorded as the Environment tag only; it is not part of resource names."
  type        = string
  default     = "prod"
}

variable "region" {
  description = "AWS region for every resource in this root (there is no us-east-1 alias)."
  type        = string
  default     = "ap-northeast-2"
}

variable "az" {
  description = "Single availability zone for the public subnet, the instance and the data volume (an EBS volume can only attach within its own AZ)."
  type        = string
  default     = "ap-northeast-2a"
}

# --- network / compute ------------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block for the dedicated VPC. 10.30.0.0/16 avoids the default VPC (172.31.0.0/16) and inno-frame (10.20.0.0/16)."
  type        = string
  default     = "10.30.0.0/16"
}

variable "instance_type" {
  description = "EC2 instance type. Must be an arm64 (Graviton) type because the AMI lookup and the container images are arm64-only. t4g.medium is the one-line upgrade if 2 GiB proves too small."
  type        = string
  default     = "t4g.small"
}

variable "root_volume_gb" {
  description = "Root EBS volume size in GiB (OS, docker image layers, swapfile)."
  type        = number
  default     = 16
}

variable "data_volume_gb" {
  description = "Size in GiB of the separate /data EBS volume (postgres, redis AOF, caddy certificates, deploy directory)."
  type        = number
  default     = 10
}

variable "data_volume_snapshot_id" {
  description = <<-EOT
    Optional EBS snapshot id to create the /data volume from (disaster recovery). Leave null for a
    fresh, empty volume. Changing this on an existing volume forces its replacement, which
    prevent_destroy blocks on purpose: restore by creating the volume from the snapshot out of band
    or by removing the old one from state first (see README).
  EOT
  type        = string
  default     = null
}

variable "snapshot_retention_count" {
  description = "How many daily DLM snapshots of the /data volume to keep."
  type        = number
  default     = 7
}

# --- domain / DNS / TLS -----------------------------------------------------------------------------

variable "domain_name" {
  description = "Public hostname of the app (also the SES sending identity). Its DNS records live in the parent zone (sboh.dev, at Cloudflare) and are entered by hand from `terraform output dns_records` (ADR-0040)."
  type        = string
  default     = "buddha.sboh.dev"
}

variable "acme_email" {
  description = "Contact e-mail Caddy registers with Let's Encrypt (expiry warnings). Written into the SSM env as ACME_EMAIL."
  type        = string

  validation {
    condition     = can(regex("@", var.acme_email))
    error_message = "acme_email must be an e-mail address (it must contain '@')."
  }
}

# --- GitHub Actions OIDC ----------------------------------------------------------------------------

variable "github_repo" {
  description = "GitHub repository (owner/name) whose main branch may assume the deploy role."
  type        = string
  default     = "sboh1214/sw04-buddha"
}

variable "github_owner_id" {
  description = "Numeric GitHub id of the repository owner, embedded in the immutable OIDC subject claim."
  type        = number
  default     = 30364442
}

variable "github_repo_id" {
  description = "Numeric GitHub id of the repository, embedded in the immutable OIDC subject claim."
  type        = number
  default     = 1354856480
}

# --- application env ---------------------------------------------------------------------------------

variable "smtp_from" {
  description = "From address for transactional mail (SMTP_FROM). Must be under domain_name: the SES sending policy only allows *@domain_name."
  type        = string
  default     = "noreply@buddha.sboh.dev"
}

variable "log_level" {
  description = "pino log level for api and worker (LOG_LEVEL)."
  type        = string
  default     = "info"
}

variable "seed_admin_email" {
  description = <<-EOT
    E-mail of the first admin account. packages/db seed creates it on the first deploy (more
    exactly: on any seed run while no account holds the admin role) and never resets it
    afterwards; once an admin exists the seed creates and promotes nobody (#171). Must be
    non-empty: with an empty value the seed silently skips the admin and the site comes up with
    no way to reach /admin.
  EOT
  type        = string

  validation {
    condition     = length(var.seed_admin_email) > 0
    error_message = "seed_admin_email must not be empty (the seed would silently skip creating the admin)."
  }
}

variable "seed_admin_password" {
  description = <<-EOT
    Initial password of the seed admin (8-128 characters, letters and digits only). The value is
    written verbatim into a dotenv line that docker compose interpolates, so characters such as
    $ " ' # or whitespace would be mangled or truncated on the way to the seed. As with the
    e-mail, an empty value makes the seed skip the admin silently.
  EOT
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9]{8,128}$", var.seed_admin_password))
    error_message = "seed_admin_password must be 8-128 characters of [A-Za-z0-9] only (dotenv/compose interpolation safety); it must not be empty."
  }
}

variable "seed_second_admin_email" {
  description = <<-EOT
    E-mail of the second bootstrap admin (optional, #171). The seed creates it together with the
    first and only then, while no account holds the admin role: the two-person rule needs two
    distinct admins in every environment, internal deploys included. Left empty, the site starts
    with one admin and the second is granted on the admin screen. Set together with
    seed_second_admin_password, and different from seed_admin_email.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = (var.seed_second_admin_email == "") == (var.seed_second_admin_password == "")
    error_message = "seed_second_admin_email and seed_second_admin_password must be set together (or both left empty)."
  }

  validation {
    condition     = var.seed_second_admin_email == "" || lower(var.seed_second_admin_email) != lower(var.seed_admin_email)
    error_message = "seed_second_admin_email must differ from seed_admin_email."
  }
}

variable "seed_second_admin_password" {
  description = <<-EOT
    Initial password of the second bootstrap admin (optional; 8-128 characters, letters and
    digits only, for the same dotenv/compose reason as seed_admin_password).
  EOT
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.seed_second_admin_password == "" || can(regex("^[A-Za-z0-9]{8,128}$", var.seed_second_admin_password))
    error_message = "seed_second_admin_password must be empty or 8-128 characters of [A-Za-z0-9] only (dotenv/compose interpolation safety)."
  }
}

# OAuth providers: leave any pair empty to keep that provider disabled in the api.
# Callback URLs to register: https://<domain_name>/api/auth/callback/{google,kakao,naver}

variable "google_client_id" {
  description = "Google OAuth client id (empty = provider disabled)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "google_client_secret" {
  description = "Google OAuth client secret (empty = provider disabled)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "kakao_client_id" {
  description = "Kakao OAuth REST API key (empty = provider disabled)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "kakao_client_secret" {
  description = "Kakao OAuth client secret (empty = provider disabled)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "naver_client_id" {
  description = "Naver OAuth client id (empty = provider disabled)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "naver_client_secret" {
  description = "Naver OAuth client secret (empty = provider disabled)."
  type        = string
  sensitive   = true
  default     = ""
}
