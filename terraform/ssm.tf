# All runtime secrets are generated here and stored, together with the non-secret settings, as ONE
# SecureString: the complete production .env. deploy/deploy.sh fetches it on every deploy and
# writes /data/buddha/.env. Nothing here is ever baked into user-data, an image or git.
#
# special = false on every password: the values are spliced into postgres:// URLs and into dotenv
# lines that docker compose interpolates, where characters like @ : / $ # " would need escaping
# that neither consumer agrees on. 32-48 alphanumerics are still 190-285 bits of entropy.

# better-auth requires >= 32 characters (apps/api/src/config/env.ts).
resource "random_password" "better_auth_secret" {
  length  = 48
  special = false
}

# The key of the keyed hash of a verified mobile number (#70, ADR-0071; apps/api/src/config/env.ts
# requires >= 32 characters in production). Unlike better_auth_secret it must NEVER be replaced
# (`-replace`, a taint): every stored hash would stop matching its number, so a number that got
# its start Coin would get it again on its next account, and every per-number limit would restart.
# Nothing at runtime notices a new key (the API starts as usual), so prevent_destroy makes the
# plan fail instead: an edit of length/special (each forces a new value), a taint, `-replace` or a
# `terraform destroy`. Taking the root down keeps the key with `terraform state mv` (README
# "중지 / 시작").
resource "random_password" "phone_hash_key" {
  length  = 48
  special = false

  lifecycle {
    prevent_destroy = true
  }
}

# postgres superuser: only postgres-init (initdb) and manual maintenance use it.
resource "random_password" "postgres_superuser" {
  length  = 32
  special = false
}

# buddha_app role: api + worker at runtime (docker/postgres/init/01-roles.sql creates the role,
# deploy/postgres-init/02-passwords.sh sets this password).
resource "random_password" "db_app" {
  length  = 32
  special = false
}

# buddha_migrate role: the one-shot migrate service only.
resource "random_password" "db_migrate" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "env" {
  name        = local.ssm_env_parameter
  description = "Complete production .env for the tf-buddha compose stack; read by deploy/deploy.sh"
  type        = "SecureString"
  # Standard tier: free, 4 KB limit (the rendered file is ~3.2 KB with every optional key set).
  tier = "Standard"

  value = templatefile("${path.module}/templates/env.tftpl", {
    ecr_registry               = local.ecr_registry
    domain                     = var.domain_name
    acme_email                 = var.acme_email
    log_level                  = var.log_level
    region                     = var.region
    db_app_password            = random_password.db_app.result
    db_migrate_password        = random_password.db_migrate.result
    better_auth_secret         = random_password.better_auth_secret.result
    phone_hash_key             = random_password.phone_hash_key.result
    smtp_user                  = aws_iam_access_key.ses_smtp.id
    smtp_pass                  = aws_iam_access_key.ses_smtp.ses_smtp_password_v4
    smtp_from                  = var.smtp_from
    google_client_id           = var.google_client_id
    google_client_secret       = var.google_client_secret
    kakao_client_id            = var.kakao_client_id
    kakao_client_secret        = var.kakao_client_secret
    naver_client_id            = var.naver_client_id
    naver_client_secret        = var.naver_client_secret
    aligo_api_key              = var.aligo_api_key
    aligo_user_id              = var.aligo_user_id
    aligo_sender               = var.aligo_sender
    aligo_test_mode            = var.aligo_test_mode
    media_s3_bucket            = aws_s3_bucket.media.bucket
    media_s3_access_key_id     = aws_iam_access_key.media.id
    media_s3_secret_access_key = aws_iam_access_key.media.secret
    postgres_password          = random_password.postgres_superuser.result
    seed_admin_email           = var.seed_admin_email
    seed_admin_password        = var.seed_admin_password
    seed_second_admin_email    = var.seed_second_admin_email
    seed_second_admin_password = var.seed_second_admin_password
  })

  tags = {
    Name = "${local.name_prefix}-env"
  }
}
