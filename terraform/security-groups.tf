# Only Caddy's two ports are reachable from the internet. There is intentionally NO port 22:
# shell access goes through SSM Session Manager (AmazonSSMManagedInstanceCore on the instance
# role), so no key pair exists and nothing listens for SSH.

resource "aws_security_group" "app" {
  name        = "${local.name_prefix}-app"
  description = "HTTP/HTTPS from anywhere to the single app host; no SSH (SSM only)"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-app"
  }
}

resource "aws_vpc_security_group_ingress_rule" "app_http" {
  security_group_id = aws_security_group.app.id
  description       = "HTTP: Caddy ACME HTTP-01 challenge and redirect to HTTPS"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  description       = "HTTPS: Caddy (web + api + Socket.IO)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "app_to_anywhere" {
  security_group_id = aws_security_group.app.id
  description       = "Egress for ECR, SSM, SES SMTP, ACME (Lets Encrypt), dnf, GitHub releases"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
