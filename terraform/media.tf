# The private bucket of the post images (#46, ADR-0073; ADR-0069 decision 2 #45-3 «비공개 S3 버킷을
# 새로 두고, API가 파일을 받아 검사·변환한 뒤 올린다») — and of the profile images #141 adds (#37-6,
# the same store). The API takes an upload, checks it by its bytes, strips its metadata, re-encodes
# it and writes the result here; every read goes back through the API (GET /api/v1/media/:id),
# which serves an image only while a visible post shows it, so hiding or deleting a post stops its
# images at once. Nothing here is ever read by a browser: every public-access block is on, there is
# no policy for readers, ACLs are off (bucket owner enforced), objects are encrypted at rest and the
# bucket refuses plain-HTTP requests.
#
# The name carries the account id: bucket names are global, and the prefix alone could be taken.

resource "aws_s3_bucket" "media" {
  bucket = "${local.name_prefix}-media-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "${local.name_prefix}-media"
  }

  # The images of every post. Destroying the bucket must be an explicit, manual act, as for the
  # data volume (storage.tf). The database reset empties it — its objects, never the bucket
  # (deploy/reset-db.sh, docs/RESET.md; owner decision 2026-10-19, ADR-0073).
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket = aws_s3_bucket.media.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# SSE-S3 (AES256): encryption at rest with no key to manage or pay for. The objects are already
# public once a post shows them; what this protects is the bucket's own copy (an upload no post
# took yet, an image an edit removed, the images of a hidden post).
resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# No versioning: an object is written once under a fresh key and never overwritten, and a
# deletion (the worker's orphan clean-up, a retention clean-up of #184) is meant to be final.
resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id

  versioning_configuration {
    status = "Disabled"
  }
}

data "aws_iam_policy_document" "media_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.media.arn,
      "${aws_s3_bucket.media.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.media_bucket.json

  # The public-access block must exist first, or S3 may judge the policy before it is in force.
  depends_on = [aws_s3_bucket_public_access_block.media]
}

# --- the app's credentials ---------------------------------------------------------------------
#
# An IAM user with an access key, like the SES SMTP user (ses.tf), rendered into the SSM env
# (MEDIA_S3_ACCESS_KEY_ID / MEDIA_S3_SECRET_ACCESS_KEY) and read only by the api and worker
# containers (deploy/compose.yaml passes them to those two). Not the instance role: ec2.tf keeps the
# IMDS hop limit at 1 so no container reaches the instance's credentials, and raising it to 2 would
# hand them — S3 included — to every container on the host, web and caddy too (ADR-0073).

resource "aws_iam_user" "media" {
  name = "${local.name_prefix}-media"

  tags = {
    Name = "${local.name_prefix}-media"
  }
}

# Exactly what @buddha/storage calls: PutObject (an upload), GetObject (a read the API serves),
# DeleteObject (the worker's orphan clean-up). ListBucket is there first because without it S3
# answers a GetObject of a missing key with 403 AccessDenied instead of 404 NoSuchKey, and the
# driver reads only the 404 as "no object" (packages/storage/src/s3.ts) — a row whose object is gone
# would be a 500 instead of the image's 404. The app itself never lists: the one caller that lists
# (and deletes the listing with DeleteObjects, which S3 authorises as DeleteObject) is the database
# reset's empty-cli.js, run in a one-off api container with this key (deploy/reset-db.sh).
data "aws_iam_policy_document" "media_app" {
  statement {
    sid = "ReadWriteMediaObjects"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  statement {
    sid       = "MissingKeyIsNotFound"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
  }
}

resource "aws_iam_user_policy" "media" {
  name   = "${local.name_prefix}-media"
  user   = aws_iam_user.media.name
  policy = data.aws_iam_policy_document.media_app.json
}

# Both values land in the local tfstate like the SMTP key: keep it out of git and back it up
# encrypted (README). Rotate with `terraform apply -replace=aws_iam_access_key.media` and redeploy.
resource "aws_iam_access_key" "media" {
  user = aws_iam_user.media.name
}
