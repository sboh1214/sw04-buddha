provider "aws" {
  region  = var.region
  profile = var.profile

  default_tags {
    tags = local.common_tags
  }
}

# No us-east-1 alias: there is no ACM certificate and no CloudFront distribution in this stack
# (Caddy terminates TLS on the host with Let's Encrypt).

