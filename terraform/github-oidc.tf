# The GitHub OIDC provider is an account-wide singleton (IAM rejects a second provider with the
# same URL) and every GitHub Actions role in the account trusts it, not only this root's (README
# "GitHub Actions 연결" lists the check). It used to be owned by the inno-frame state and only read
# here; inno-frame's `terraform destroy` (2026-09-22) deleted it, and the next deploy failed with
# "The web identity token provided could not be validated" (ADR-0040 추기). This root owns it now.
# Other roots read it with a data source only, never a resource and never an import: a second
# owning state would delete it for everyone on its own destroy.
# No thumbprint_list: AWS validates GitHub's tokens against its own trusted CAs. IAM fills the
# thumbprint in when it creates the provider; Terraform only reads it back.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # Overrides default_tags' Project = buddha: a cleanup of buddha's resources must not sweep up a
  # shared one. TerraformRoot names the owning state. No Name tag: IAM identifies the provider by
  # its URL, so it is the one exception to the tf-buddha- prefix.
  tags = {
    Project       = "shared"
    TerraformRoot = "sw04-buddha/terraform"
  }

  # Deleting it breaks every GitHub Actions deploy in the account at once. Taking this root down
  # leaves it in place (`terraform state rm` first, README "중지 / 시작"); deleting the provider
  # itself is a manual act once no other role trusts it (as for the /data volume).
  lifecycle {
    prevent_destroy = true
  }
}

data "aws_iam_policy_document" "github_oidc_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Immutable subject format (see locals.tf): only pushes to main of this exact repository id.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_oidc_subject]
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  name               = "${local.name_prefix}-github-deploy"
  description        = "Assumed by GitHub Actions via OIDC to push images to ECR and run deploy.sh on the host through SSM"
  assume_role_policy = data.aws_iam_policy_document.github_oidc_trust.json
}

data "aws_iam_policy_document" "github_actions_deploy" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
    ]
    resources = [for r in aws_ecr_repository.app : r.arn]
  }

  # workflow_dispatch with an existing tag (rollback) verifies the tag exists instead of building.
  statement {
    sid       = "EcrDescribe"
    actions   = ["ecr:DescribeImages"]
    resources = [for r in aws_ecr_repository.app : r.arn]
  }

  # The workflow finds the host by tag:Name=tf-buddha-app; DescribeInstances is not resource-scopable.
  statement {
    sid       = "FindInstance"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  # Run Command is limited to this one instance and the stock shell-script document.
  statement {
    sid     = "SsmSendCommand"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.app.arn,
      "arn:aws:ssm:${var.region}::document/AWS-RunShellScript",
    ]
  }

  statement {
    sid = "SsmReadResult"
    actions = [
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name   = "${local.name_prefix}-github-deploy"
  role   = aws_iam_role.github_actions_deploy.id
  policy = data.aws_iam_policy_document.github_actions_deploy.json
}
