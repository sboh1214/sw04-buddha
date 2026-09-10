# The account is already out of the SES sandbox in this region, so once this identity's DKIM and
# MAIL FROM records (entered by hand in Cloudflare from `terraform output dns_records`) verify,
# mail can go to any recipient.

# DO NOT add `dkim_signing_attributes { next_signing_key_length = ... }`:
# specifying the key length rotates the SES DKIM tokens, which invalidates
# the published ses_dkim CNAMEs and leaves outbound mail unsigned until DNS
# reconverges. EasyDKIM defaults persist through `terraform import`.
resource "aws_sesv2_email_identity" "app" {
  email_identity = var.domain_name

  tags = {
    Name = "${local.name_prefix}-ses-identity"
  }
}

# Custom MAIL FROM so SPF aligns with the From domain for DMARC. USE_DEFAULT_VALUE keeps mail
# flowing (amazonses.com Return-Path) if the MX record ever disappears; alignment degrades but
# sending never blocks on a DNS hiccup.
resource "aws_sesv2_email_identity_mail_from_attributes" "app" {
  email_identity         = aws_sesv2_email_identity.app.email_identity
  mail_from_domain       = "mail.${var.domain_name}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# --- SMTP credentials for the api (nodemailer, STARTTLS on 587) ------------------------------------

resource "aws_iam_user" "ses_smtp" {
  name = "${local.name_prefix}-ses-smtp"

  tags = {
    Name = "${local.name_prefix}-ses-smtp"
  }
}

data "aws_iam_policy_document" "ses_smtp" {
  statement {
    sid = "SendFromAppDomain"
    actions = [
      "ses:SendEmail",
      "ses:SendRawEmail",
    ]
    resources = [aws_sesv2_email_identity.app.arn]

    # Even with the identity ARN scoped, pin the From address so a leaked credential cannot
    # impersonate arbitrary mailboxes under the domain via a differently-verified identity.
    condition {
      test     = "StringLike"
      variable = "ses:FromAddress"
      values   = ["*@${var.domain_name}"]
    }
  }
}

resource "aws_iam_user_policy" "ses_smtp" {
  name   = "${local.name_prefix}-ses-smtp"
  user   = aws_iam_user.ses_smtp.name
  policy = data.aws_iam_policy_document.ses_smtp.json
}

# .id is SMTP_USER and .ses_smtp_password_v4 (SigV4-derived for this region) is SMTP_PASS; both
# are rendered into the SSM env by ssm.tf. Both also land in the local tfstate: keep it out of git
# and back it up encrypted (README). Rotate with `terraform apply -replace=aws_iam_access_key.ses_smtp`.
resource "aws_iam_access_key" "ses_smtp" {
  user = aws_iam_user.ses_smtp.name
}
