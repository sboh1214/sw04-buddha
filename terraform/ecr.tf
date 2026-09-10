# One repository per image; tags are git shas pushed by the CD workflow (no :latest).
# MUTABLE because a re-run of the workflow for the same sha must be able to overwrite the tag.
resource "aws_ecr_repository" "app" {
  for_each = local.images

  name                 = "${local.name_prefix}-${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name = "${local.name_prefix}-${each.key}"
  }
}

# Same two rules as inno-frame: 10 tagged images = the last 10 deploys stay available for a
# tag-only rollback; untagged (overwritten) layers age out after a week.
resource "aws_ecr_lifecycle_policy" "app" {
  for_each = aws_ecr_repository.app

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 10
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Expire untagged images older than 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
    ]
  })
}
