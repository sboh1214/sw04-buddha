# No sensitive outputs on purpose: everything secret stays inside the SSM parameter / tfstate.

output "instance_id" {
  description = "EC2 instance id of the app host. Used by `aws ssm start-session --target` and by the README runbooks."
  value       = aws_instance.app.id
}

output "public_ip" {
  description = "Elastic IP of the app host. Compare with `dig +short A <domain>` after apply."
  value       = aws_eip.app.public_ip
}

output "app_url" {
  description = "Public URL of the app (BETTER_AUTH_URL / WEB_ORIGIN). Used for the smoke test and the OAuth callback registration."
  value       = local.app_url
}

output "ecr_registry" {
  description = "ECR registry host. Also rendered into the SSM env as ECR_REGISTRY for docker compose."
  value       = local.ecr_registry
}

output "ecr_repository_urls" {
  description = "Map image name -> repository URL. The CD workflow tags images as <url>:<git sha>."
  value       = { for k, r in aws_ecr_repository.app : k => r.repository_url }
}

output "github_actions_deploy_role_arn" {
  description = "IAM role the workflow assumes. Set it with: gh secret set AWS_DEPLOY_ROLE_ARN --repo sboh1214/sw04-buddha --body <arn>"
  value       = aws_iam_role.github_actions_deploy.arn
}

output "github_oidc_subject" {
  description = "Exact sub claim the trust policy expects. Must equal `gh api repos/<repo>/actions/oidc/customization/sub` prefix + ':ref:refs/heads/main'."
  value       = local.github_oidc_subject
}

output "ssm_env_parameter_name" {
  description = "SecureString holding the production .env. deploy/deploy.sh reads it; inspect with `aws ssm get-parameter --with-decryption`."
  value       = aws_ssm_parameter.env.name
}

output "data_volume_id" {
  description = "EBS volume id of /data. Used to find its DLM snapshots (`aws ec2 describe-snapshots --filters Name=volume-id,Values=<id>`)."
  value       = aws_ebs_volume.data.id
}

output "ses_identity_arn" {
  description = "SES identity ARN. Check verification with `aws sesv2 get-email-identity --email-identity <domain>` before inviting testers."
  value       = aws_sesv2_email_identity.app.arn
}

output "ssm_session_command" {
  description = "Copy-paste shell access to the host (requires the session-manager-plugin)."
  value       = "aws ssm start-session --profile ${var.profile} --region ${var.region} --target ${aws_instance.app.id}"
}

# DNS is NOT managed here (owner decision, ADR-0040): the parent zone sboh.dev lives at Cloudflare
# and the records below are entered by hand from this output after the first apply. Every record
# must be DNS-only (grey cloud): Caddy solves HTTP-01 on the host and the api trusts Caddy alone for
# X-Forwarded-For. The three DKIM tokens only exist once the SES identity has been created.
output "dns_records" {
  description = "Records to create in the Cloudflare zone sboh.dev, all with proxy OFF (DNS only). `terraform output dns_records` prints them as a table-ready list."
  value = concat(
    [
      {
        type     = "A"
        name     = var.domain_name
        content  = aws_eip.app.public_ip
        priority = null
        ttl      = 300
        purpose  = "app host (Caddy); DNS-only so HTTP-01 reaches the host"
      },
    ],
    [
      for token in aws_sesv2_email_identity.app.dkim_signing_attributes[0].tokens : {
        type     = "CNAME"
        name     = "${token}._domainkey.${var.domain_name}"
        content  = "${token}.dkim.amazonses.com"
        priority = null
        ttl      = 3600
        purpose  = "SES EasyDKIM (all three are required for the identity to verify)"
      }
    ],
    [
      {
        type     = "MX"
        name     = "mail.${var.domain_name}"
        content  = "feedback-smtp.${var.region}.amazonses.com"
        priority = 10
        ttl      = 3600
        purpose  = "SES custom MAIL FROM (bounce/complaint feedback); this subdomain must carry exactly one MX"
      },
      {
        type     = "TXT"
        name     = "mail.${var.domain_name}"
        content  = "v=spf1 include:amazonses.com ~all"
        priority = null
        ttl      = 3600
        purpose  = "SPF for the MAIL FROM subdomain"
      },
      {
        type     = "TXT"
        name     = "_dmarc.${var.domain_name}"
        content  = "v=DMARC1; p=quarantine; pct=100"
        priority = null
        ttl      = 3600
        purpose  = "DMARC (SPF and DKIM are both aligned via SES)"
      },
    ],
  )
}
