# /data lives on its own volume so the instance can be replaced (AMI refresh, resize) without
# touching postgres, redis, the Let's Encrypt account/certificates or the deploy directory. The
# host mounts it by filesystem label (templates/user-data.sh.tftpl), never by device name.

resource "aws_ebs_volume" "data" {
  availability_zone = var.az
  type              = "gp3"
  size              = var.data_volume_gb
  encrypted         = true
  snapshot_id       = var.data_volume_snapshot_id

  tags = {
    Name = "${local.name_prefix}-data"
    # Selector for the DLM policy below; the value is meaningless beyond matching target_tags.
    "buddha:snapshot" = "daily"
  }

  # The only stateful thing in the whole stack. Destroying it must be an explicit, manual act.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.app.id

  # Detaching a mounted ext4 volume from a running host risks a dirty filesystem; stopping first
  # (during -replace) makes the detach clean at the cost of a short outage.
  stop_instance_before_detaching = true
}

# --- Data Lifecycle Manager: one snapshot per day, keep the last N ---------------------------------

data "aws_iam_policy_document" "dlm_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${local.name_prefix}-dlm"
  description        = "Assumed by Data Lifecycle Manager to snapshot the tf-buddha data volume"
  assume_role_policy = data.aws_iam_policy_document.dlm_assume_role.json
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "data" {
  description        = "${local.name_prefix} data volume daily snapshots" # DLM allows only [0-9A-Za-z _-]
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    target_tags = {
      "buddha:snapshot" = "daily"
    }

    schedule {
      name = "daily"

      # 18:00 UTC = 03:00 KST, the quietest hour for a Korean user base. Snapshots are
      # crash-consistent (postgres WAL replays on restore); a logical pg_dump is the belt to
      # this suspender and is documented in the README.
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["18:00"]
      }

      retain_rule {
        count = var.snapshot_retention_count
      }

      copy_tags = true

      tags_to_add = {
        Name = "${local.name_prefix}-data-snapshot"
      }
    }
  }

  tags = {
    Name = "${local.name_prefix}-data-snapshot-policy"
  }
}
