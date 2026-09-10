data "aws_caller_identity" "current" {}

locals {
  # Literal "tf-buddha-" prefix on every resource name / Name tag, as requested by the owner.
  # This is a deliberate deviation from inno-frame's "tf-<project>-<env>" scheme: the environment
  # is recorded as a tag only (common_tags.Environment), never in the name.
  name_prefix = "tf-${var.project}"

  common_tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  # One ECR repository per Dockerfile target; the CD workflow and deploy/compose.yaml use the
  # same three names (tf-buddha-api / tf-buddha-worker / tf-buddha-web).
  images = toset(["api", "worker", "web"])

  ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"

  app_url = "https://${var.domain_name}"

  # Single SecureString holding the whole production .env; deploy/deploy.sh hard-codes this path.
  ssm_env_parameter = "/${local.name_prefix}/env"

  # This repository has its OIDC subject claim customised to the IMMUTABLE format
  # (`gh api repos/<owner>/<repo>/actions/oidc/customization/sub`), which embeds the numeric
  # owner and repository ids so a renamed or re-created repo cannot inherit the trust. The
  # default "repo:<owner>/<repo>:ref:..." form (as used in inno-frame) would never match here.
  github_oidc_subject = "repo:${split("/", var.github_repo)[0]}@${var.github_owner_id}/${split("/", var.github_repo)[1]}@${var.github_repo_id}:ref:refs/heads/main"
}
