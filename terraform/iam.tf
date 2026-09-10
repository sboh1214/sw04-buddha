# Instance role: exactly what deploy.sh and the SSM agent need. No S3, no CloudWatch Logs.

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${local.name_prefix}-app"
  description        = "tf-buddha app host: SSM agent, ECR pull, read the /tf-buddha/env parameter"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${local.name_prefix}-app"
  role = aws_iam_role.app.name
}

# Session Manager + Run Command. Note this managed policy already grants ssm:GetParameter on *,
# so the ReadEnvParameter statement below is documentation of intent more than an extra grant.
resource "aws_iam_role_policy_attachment" "app_ssm_core" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "app" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPull"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]
    resources = [for r in aws_ecr_repository.app : r.arn]
  }

  statement {
    sid       = "ReadEnvParameter"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.env.arn]
  }

  # The SecureString is encrypted with the AWS-managed key alias/aws/ssm. That key does not exist
  # in a region until the first SecureString is written there (it is created lazily), so a
  # `data "aws_kms_alias"` lookup would fail on a fresh account/region at plan time. Granting
  # kms:Decrypt on * but only when called through the SSM service in this region is the
  # documented alternative and is equivalent in effect.
  statement {
    sid       = "DecryptEnvParameter"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "${local.name_prefix}-app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}
