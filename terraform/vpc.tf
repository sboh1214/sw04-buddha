# Deliberately minimal: one public subnet in one AZ, no NAT gateway, no private subnets, no VPC
# endpoints. The single instance talks to ECR/SSM/SES over its public IP; a NAT gateway alone
# would cost more than the instance.

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${local.name_prefix}-vpc"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-igw"
  }
}

resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.main.id
  availability_zone = var.az
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 0)

  # The instance sets associate_public_ip_address explicitly; this is the subnet default only.
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name_prefix}-public-${var.az}"
    Tier = "public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.name_prefix}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}
