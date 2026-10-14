# TERRAFORM 인프라 지식 베이스 (tf-buddha)

배포 인프라 — VPC 1개 + EC2 `t4g.small` 1대(Docker Compose + Caddy) + 별도 EBS(DLM 스냅샷) + ECR + SSM Parameter Store + SES + GitHub OIDC provider(계정 공용) + 배포 역할(DNS는 Cloudflare에 수동 — `terraform output dns_records`). 월 ≈ $22, 내부 테스터 3명용(ADR-0040). 로컬 tfstate.

## 어디를 봐야 하는가

| 작업                                               | 위치                                                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 일상 운영 절차 (롤백, 셸, 로그, 시크릿 교체, 복구) | `README.md`                                                                                                                                                      |
| 변수 / 입력                                        | `variables.tf`, `terraform.tfvars.example` (실제 `terraform.tfvars`는 gitignored)                                                                                |
| 출력 (워크플로·운영 명령이 소비)                   | `outputs.tf`                                                                                                                                                     |
| 리소스 이름 prefix                                 | `locals.tf` (`name_prefix = "tf-${var.project}"` = `tf-buddha`; 환경은 태그로만)                                                                                 |
| 네트워크                                           | `vpc.tf` (VPC + 퍼블릭 서브넷 1개, NAT 없음), `security-groups.tf` (80/443만)                                                                                    |
| 컴퓨트                                             | `ec2.tf` (AMI data source, 인스턴스, EIP), `templates/user-data.sh.tftpl` (첫 부팅 1회)                                                                          |
| 데이터 볼륨 / 스냅샷                               | `storage.tf` (`aws_ebs_volume.data` + attachment + DLM)                                                                                                          |
| 컨테이너 이미지 저장소                             | `ecr.tf` (`tf-buddha-api` / `-worker` / `-web`)                                                                                                                  |
| 운영 `.env` (시크릿)                               | `ssm.tf` (`random_password` ×4 + SecureString `/tf-buddha/env`), `templates/env.tftpl` (본문)                                                                    |
| 인증/권한                                          | `iam.tf` (인스턴스 역할), `github-oidc.tf` (GitHub OIDC provider — 계정 공용, `prevent_destroy` + 배포 역할 + immutable subject)                                 |
| 이메일 (SES)                                       | `ses.tf` (identity `buddha.sboh.dev`, MAIL FROM `mail.buddha.sboh.dev`, SMTP IAM user) — DNS 레코드는 `outputs.tf`의 `dns_records`                               |
| DNS                                                | Terraform 밖. `outputs.tf`의 `dns_records`를 Cloudflare 대시보드에 손으로 등록(A DNS-only + DKIM CNAME ×3 + MAIL FROM MX/SPF + DMARC)                            |
| 호스트에서 실제로 도는 것                          | `../deploy/` (compose.yaml, Caddyfile, deploy.sh, host-setup.sh, reset-db.sh, postgres-init/02-passwords.sh) — api 이미지에 동봉되어 SSM이 `/data/buddha`에 푼다 |
| 이미지 빌드                                        | `../Dockerfile` (multi-target `api` / `worker` / `web`), `../.dockerignore`                                                                                      |
| CD                                                 | `../.github/workflows/deploy.yml` (OIDC → ECR → SSM Run Command → `/api/health` 스모크)                                                                          |

## 핵심 컨벤션

- **모든 리소스 이름과 `Name` 태그는 `tf-buddha-`로 시작한다** (`local.name_prefix`). inno-frame의 `tf-<project>-<env>`에서 의도적으로 이탈한 것이고, 환경(`prod`)은 `default_tags`의 `Environment` 태그로만 남긴다. 같은 계정의 다른 프로젝트(inno-frame `tf-inno-frame-prod-*` — 2026-09-22 destroy됨, sai-web)와 접두사로 구분된다. 계정 공용 GitHub OIDC provider만 예외다(URL로 식별, `Name` 태그 없음, `Project = shared`).
- **HCL 주석은 영문으로 WHY를 적고, README/AGENTS.md는 한국어 산문 + 영문 식별자.** 관심사별로 파일 하나. IAM 정책은 전부 `data "aws_iam_policy_document"`, SG 규칙은 분리형 `aws_vpc_security_group_ingress_rule` / `_egress_rule`, 태그는 provider `default_tags`.
- **시크릿은 `random_password` → `aws_ssm_parameter.env`(SecureString 하나) → `deploy.sh`가 `.env`로 렌더.** `.tf`·`.tfvars.example`·user-data·git 어디에도 값이 없다. 사용자 입력 시크릿(OAuth 키, seed 관리자 비밀번호)은 sensitive `var.*`로 `terraform.tfvars`에서만 온다. 전부 로컬 tfstate에 평문으로 들어가므로 README의 오프머신 백업 절차를 따른다.
- **`aws_instance.app`은 `ignore_changes = [ami, user_data]`.** 월간 AMI 갱신이 유일한 호스트를 재생성하지 못하게 하는 장치. 호스트 교체는 언제나 `terraform apply -replace=aws_instance.app` + 워크플로 재실행이다. 첫 부팅 뒤에 바뀔 수 있는 호스트 설정은 user-data가 아니라 `deploy/host-setup.sh`(배포마다 실행, 멱등)에 둔다.
- **데이터는 `/data`(별도 EBS, `prevent_destroy`)에만 있다.** 라벨 `buddha-data`로 마운트하고 docker.service에 `RequiresMountsFor=/data`를 걸어 두었다. compose에 named volume은 없다 — 전부 `/data` bind mount라 DLM 스냅샷 하나가 postgres·redis·Caddy 인증서·배포 디렉터리를 함께 담는다.
- **Cloudflare A 레코드는 DNS-only(회색 구름)다.** Caddy가 호스트에서 HTTP-01로 인증서를 직접 받는다(Let's Encrypt → ZeroSSL 폴백, `deploy/Caddyfile`에 `acme_ca` 없음). DNS는 Terraform이 관리하지 않으므로(사용자 결정) `terraform output dns_records`의 값을 대시보드에 그대로 넣고, EIP를 재생성했을 때는 A 레코드를 손으로 고친다.
- **compose IPAM 주소는 계약이다**: Caddy `172.28.0.10`, web `172.28.0.20`. `templates/env.tftpl`의 `TRUST_PROXY=172.28.0.10/32`와 `RATE_LIMIT_UNCOUNTED_PEERS=172.28.0.20/32`, `deploy/compose.yaml`의 `extra_hosts`가 이 값을 가리킨다(ADR-0034). 하나를 바꾸면 셋을 같이 바꾼다.
- **GitHub OIDC subject는 immutable 형식**: `repo:sboh1214@30364442/sw04-buddha@1354856480:ref:refs/heads/main` (`local.github_oidc_subject`). 이 저장소의 sub claim 커스터마이즈 결과이고, owner id·repo id가 박혀 있다. `aws_iam_openid_connect_provider.github`는 **이 root가 소유**한다(계정 공용 싱글턴, `prevent_destroy`, 2026-10-02부터). 2026-09-22까지는 inno-frame state가 소유하고 여기서는 data source로 읽었으나, inno-frame의 destroy가 지워 2026-10-01 배포가 끊겼다(ADR-0040 추기). sai-web의 `sai-production-github-deploy`도 같은 provider를 신뢰한다 — 이 root를 내릴 때는 먼저 `terraform state rm`으로 provider를 놓는다(README「중지 / 시작」).
- **SES identity에 `dkim_signing_attributes`를 적지 않는다.** EasyDKIM 기본값을 쓰고 토큰은 `outputs.tf`의 `dns_records`가 identity 속성에서 읽어 보여 준다. identity를 재생성하면 토큰이 바뀌어 DKIM이 끊긴다.
- **`ssm:SendCommand`는 `aws_instance.app.arn`에 고정.** 인스턴스를 교체하는 apply가 정책도 다시 쓴다. 콘솔에서 인스턴스를 바꿨으면 apply를 한 번 더.
- **`seed_admin_email` / `seed_admin_password`는 validation으로 빈 값(공백만 있는 이메일 포함)을 거절한다.** 비어 있으면 seed가 관리자와 시드 시장을 조용히 건너뛰어 관리자 없는 사이트가 된다(`packages/db/src/seed.ts`). 둘째 관리자 `seed_second_admin_*`는 선택이고(#171) 둘 다 채우거나 둘 다 비운다. 공백만 있는 값은 빈 값으로 본다(dotenv 줄과 시드가 그렇게 읽는다). 시드는 관리자가 한 명도 없을 때만 두 관리자를 만들므로, 첫 배포 뒤에 바꾼 값은 아무 계정도 만들지 않는다.
- `terraform plan`은 첫 배포 뒤 항상 `No changes`여야 한다. drift 후보는 README의 「주시해야 할 drift」. 특히 `aws_dlm_lifecycle_policy.data`의 `state = "ERROR" -> "ENABLED"`는 스냅샷이 실패하고 있다는 뜻이다(README「스냅샷 확인」).

## 안티 패턴 (이 디렉터리)

- **금지**: `tf-buddha-` prefix 없는 리소스 이름 / `Name` 태그(계정 공용 OIDC provider만 예외). 콘솔에서 같은 계정의 다른 프로젝트 리소스와 섞인다.
- **금지**: user-data(`templates/user-data.sh.tftpl`)나 git(`.tf`, `.tfvars.example`, `deploy/`)에 시크릿. 시크릿은 `random_password` 또는 sensitive `var.*` → `/tf-buddha/env`뿐이다. user-data는 인스턴스 메타데이터로 누구나(인스턴스 안에서) 읽는다.
- **금지**: `deploy/Caddyfile`에 `acme_ca`를 다시 넣는 것. 단일 CA로 고정되어 ZeroSSL 폴백이 사라진다 — 2026-09-11 첫 배포가 LE 원격 검증 장애로 몇 시간 막혔던 이유다.
- **금지**: ACME 발급이 실패한다고 Caddy를 반복 재시작하는 것. 실패마다 Let's Encrypt의 "failed authorizations 5회/시간" 한도를 소모한다. Caddy의 자체 재시도와 폴백에 맡긴다(README "TLS 인증서").
- **금지**: Cloudflare 레코드 `proxied = true`. 오렌지 구름이 켜지는 순간 HTTP-01이 Cloudflare 엣지에서 끝나고 Caddy가 인증서를 못 받는다. 와일드카드 proxied 레코드도 같은 효과다.
- **금지**: `TRUST_PROXY=true`. 값은 프록시 CIDR(`172.28.0.10/32`)이다. `true`면 클라이언트가 보낸 `X-Forwarded-For`를 믿게 되어 주소별 레이트 리밋이 우회된다(ADR-0034, A-M0-13).
- **금지**: 22번 포트 ingress·키 페어·SSH 데몬. 셸은 `aws ssm start-session`뿐이다.
- **금지**: `aws_sesv2_email_identity.app`에 `dkim_signing_attributes` 지정, 또는 identity destroy/recreate. 둘 다 새 DKIM 토큰을 발급해 CNAME 세 개를 전부 stale로 만든다.
- **금지**: compose IPAM 주소(`172.28.0.10` / `172.28.0.20`)를 바꾸면서 `templates/env.tftpl`(`TRUST_PROXY`, `RATE_LIMIT_UNCOUNTED_PEERS`)과 `deploy/Caddyfile`·`deploy/compose.yaml`(`extra_hosts`)을 같이 안 바꾸기. 어긋나면 레이트 리밋이 사이트 전체를 한 통으로 세거나(ADR-0034) SSR 헤어핀이 끊긴다.
- **금지**: `.dockerignore`에 `deploy/` 또는 `docker/postgres/init/` 추가. api 이미지가 배포 번들을 실어 나른다 — 빠지면 SSM 배포 단계의 `docker cp`가 빈 디렉터리를 푼다.
- **금지**: swap을 `fallocate`로 만들기. AL2023 루트는 XFS라 `swapon`이 거절한다. user-data는 `dd`를 쓴다.
- **금지**: compose에서 Docker Hub(`docker.io`) 이미지를 직접 pull. 익명 pull 한도로 배포가 무작위로 실패한다. 인프라 이미지는 `public.ecr.aws/docker/library/*`(같은 digest)로.
- **금지**: `templates/user-data.sh.tftpl`을 고치고 `terraform apply -replace=aws_instance.app`을 생략. `user_data`가 `ignore_changes`라 plan이 `No changes`를 답하고 변경은 어디에도 반영되지 않는다.
- **금지**: OIDC 신뢰 정책에 inno-frame 형식 `repo:sboh1214/sw04-buddha:ref:refs/heads/main` 복사. 이 저장소의 sub claim은 immutable 형식이라 그 문자열은 영원히 매치되지 않고, 워크플로는 `Not authorized to perform sts:AssumeRoleWithWebIdentity`로 죽는다.
- **금지**: `/tf-buddha/env`를 콘솔에서 편집. `aws_ssm_parameter.env`는 템플릿 렌더 결과라 다음 apply가 덮어쓴다. `terraform.tfvars` 또는 `templates/env.tftpl`을 고친다.
- **금지**: `aws_iam_openid_connect_provider.github`의 `prevent_destroy` 제거를 커밋, 이 root를 내리면서 provider까지 destroy(먼저 `state rm`), 또는 다른 Terraform root에서 GitHub OIDC provider를 `resource`로 만들거나 import하기. 계정에 하나뿐이라 다른 root는 data source로만 읽는다 — 소유한 state의 destroy가 계정의 모든 GitHub Actions 배포를 끊는다(2026-09-22 inno-frame destroy).
- **금지**: `aws_ebs_volume.data`의 `prevent_destroy` 제거를 커밋. 스냅샷 복구 절차(README)에서 **일시적으로** 주석 처리하고 즉시 복원한다.
- **금지**: root 자격증명으로 apply. `aws sts get-caller-identity --profile inno-frame`이 `user/terraform-iam`이어야 한다.
