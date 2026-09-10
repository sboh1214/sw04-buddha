# Latest AL2023 arm64 AMI id, resolved at plan time from the public SSM parameter. The instance
# ignores later changes to `ami`, so this only decides what a NEW instance boots from.
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = var.instance_type
  availability_zone      = var.az
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.app.name

  # cloud-init needs internet (dnf, GitHub) before the EIP association exists. The ephemeral
  # public IP is released as soon as the EIP is attached, so it never costs a second IPv4.
  associate_public_ip_address = true

  # No unlimited-mode surprises on the bill: sustained CPU above baseline just throttles.
  credit_specification {
    cpu_credits = "standard"
  }

  # Detailed (1-minute) CloudWatch metrics are paid; basic 5-minute metrics are enough here.
  monitoring = false

  # IMDSv2 only, and hop limit 1 keeps containers (one NAT hop away) from reaching the instance
  # role credentials. deploy.sh runs on the host itself and is unaffected.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true

    tags = {
      Name = "${local.name_prefix}-root"
    }
  }

  # First-boot script only: no secrets, no application files. It formats/mounts the data volume by
  # the id Terraform already knows, which is why the volume is created before the instance.
  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    data_volume_id_nodash = replace(aws_ebs_volume.data.id, "-", "")
  })

  # The monthly AL2023 AMI bump and any edit to the user-data template would otherwise replace
  # the only host on the next apply. Replacement is an explicit decision:
  #   terraform apply -replace=aws_instance.app
  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = {
    Name = "${local.name_prefix}-app"
  }
}

# Stable public IPv4 (the Cloudflare A record points here). Created after the IGW so AWS does not
# reject the allocation for a VPC that cannot route to the internet yet.
resource "aws_eip" "app" {
  domain = "vpc"

  tags = {
    Name = "${local.name_prefix}-app-eip"
  }

  depends_on = [aws_internet_gateway.main]
}

# Separate association resource so a `-replace=aws_instance.app` keeps the same address (and
# therefore the same DNS record and Let's Encrypt account) across host replacements.
resource "aws_eip_association" "app" {
  instance_id   = aws_instance.app.id
  allocation_id = aws_eip.app.id
}
