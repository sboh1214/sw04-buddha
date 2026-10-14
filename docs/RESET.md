# 운영 DB 초기화

배포 환경(buddha.sboh.dev)의 Postgres와 Redis를 비우고 시드로 다시 채우는 절차다. #125가 마이그레이션 0017로 한 번 비웠다(ADR-0048). 배포 환경에는 실사용자·실결제 데이터가 없어 초기화하고 다시 시드해도 된다(ADR-0047 D4). **되돌릴 수 없다.** `deploy/reset-db.sh`는 계정까지 모두 지우고 테스터는 다시 가입한다. 오너가 #125의 초기화에 정한 범위다(ADR-0048 결정 1-4).

#149의 출시 전 재초기화는 이 절차를 쓰지만, 다시 초기화할지와 무엇을 남길지는 #133 14항이 정한다(ADR-0047 결정 10). 다시 하지 않을 수도 있다. 출시 설정의 값과 변경 기록을 남길지도 #133이 정한다(오너 결정 2026-10-13\~14, ADR-0055). #133이 운영자 계정이나 사용자 계정처럼 무엇이든 남기기로 하면 #149 전에 이 절차(비우는 문장과 스크립트)를 그 범위로 먼저 좁혀야 한다. 아래는 지금의 절차, 곧 모두 지우는 경우다.

## 지우는 것과 남는 것

| 구분      | 내용                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 지운다    | Postgres `public` 스키마의 모든 테이블: 계정·세션·인증, 프로필·잔고·원장, 시장·주문·체결·포지션·틱·이벤트, 결제·쿠폰·충전 상품, 카테고리, 관리자 작업 기록, 출시 설정의 값과 상태(`release_settings`, 변경 기록은 관리자 작업 기록에 있다, docs/SETTINGS.md. 남길지는 #133이 정하고 그 전까지는 함께 지운다). 일련번호도 1부터 다시 센다                                                                               |
| 지운다    | Redis 전체(`FLUSHALL`): BullMQ 큐와 지연 잡(마감·정산 예약), 반복 잡 스케줄러, 레이트 리밋 카운터, 역할 캐시                                                                                                                                                                                                                                                                                                           |
| 남는다    | 스키마·롤·권한, 마이그레이션 기록(`drizzle.__drizzle_migrations`, 다른 스키마라 `db:migrate`가 다시 할 일이 없다), `/data/buddha`의 배포 파일과 `.env`, Caddy 인증서                                                                                                                                                                                                                                                   |
| 다시 채움 | 시드: 카테고리 5개(+세부 21개), 판매 중지 충전 상품 5개, 관리자(`SEED_ADMIN_*`), 검수 전 초안 시장 14개. 워커가 기동하면서 반복 잡(매 분 마감·정산 스캔, 04:00 원장 감사)을 다시 건다                                                                                                                                                                                                                                  |
| 결과      | 모든 세션이 사라져 전원이 로그아웃된다. 테스터는 다시 가입하고 가입 지급을 받는다. 관리자도 첫 로그인에서 `/onboarding`을 다시 만난다(ADR-0043). 초안 시장은 다른 검수자가 규칙을 확인한 뒤 연다(N03 §2). 마감 시각이 지난 초안은 관리자가 마감 시각을 고치기 전에는 열 수 없다. 시드는 출시 설정 값을 쓰지 않으므로(오너 결정, ADR-0055) 모든 항목이 미정이고, 관리자가 `/admin/settings`에서 사유와 함께 다시 넣는다 |

## 한 문장, 두 곳

비우는 문장은 `packages/db/src/wipe.ts`의 `WIPE_PUBLIC_TABLES_SQL` 하나다. `public` 스키마의 테이블 목록을 실행할 때 `pg_tables`에서 읽어 `TRUNCATE … RESTART IDENTITY CASCADE`하므로, 뒤에 생기는 테이블도 빠지지 않는다. TRUNCATE는 테이블 소유자의 권한이라 `buddha_migrate`로 돈다(`buddha_app`은 할 수 없다).

- **마이그레이션 0017**(`packages/db/drizzle/0017_remove_direct_amm.sql`)의 첫 문장이 이 문장 그대로다. #125 배포 때 한 번 돈다.
- **재초기화**는 `packages/db/src/wipe-cli.ts`(빌드 결과 `packages/db/dist/wipe-cli.js`, api 이미지에 들어 있다)로 같은 문장을 다시 돌린다. 운영 호스트에서는 `deploy/reset-db.sh`가 부른다.
- `packages/db/src/wipe.test.ts`가 둘이 같은 문장인지, 스크립트가 그 CLI를 부르는지 고정한다. 시험 하네스의 `reset()`도 같은 문장으로 매 DB 시험 전에 비운다.
- `packages/db/src/reset-db.test.ts`가 `deploy/reset-db.sh`를 가짜 `docker`로 실제로 돌려 단계 순서와 덤프 처리(아래 3·9단계, 실패하면 남김)를 고정한다.

## 운영 호스트에서

**준비.**

- 배포된 이미지가 #125 이후의 것이어야 한다(`wipe-cli.js`가 있다). 스크립트가 아무것도 멈추기 전에 확인한다.
- 테스터에게 미리 알린다: 전원 로그아웃되고, 계정·잔고·기록이 모두 사라지며, 다시 가입해야 한다.
- (선택) 워크스테이션의 `terraform/`에서 EBS 수동 스냅샷을 뜬다. 스크립트도 시작할 때 `pg_dump`를 뜨지만 초기화가 끝까지 성공하면 지우므로, 성공한 뒤의 확인에서 문제가 보였을 때 되돌릴 길은 이 스냅샷뿐이다.

```bash
aws ec2 create-snapshot --profile inno-frame --volume-id "$(terraform output -raw data_volume_id)" \
  --description pre-reset
```

**실행.** 셸은 `aws ssm start-session --profile inno-frame --target "$(terraform output -raw instance_id)"`([terraform/README.md](../terraform/README.md#셸)).

```bash
sudo bash /data/buddha/reset-db.sh --yes
```

스크립트는 배포마다 api 이미지에서 `/data/buddha`로 풀린다. `--yes`가 없으면 아무것도 하지 않고 끝난다. 하는 일은 차례로 다음과 같다.

1. `/data`가 마운트되어 있는지 확인하고 `deploy.sh`와 같은 락(`/data/buddha/.deploy.lock`)을 잡는다. 배포와 겹치지 않는다.
2. postgres·redis가 떠 있게 하고, 배포된 api 이미지에 `wipe-cli.js`가 있는지 확인한다. 없으면 여기서 끝나고 사이트는 그대로다.
3. `pg_dump`를 `/data/buddha-pre-reset-<시각>.dump`(소유자만 읽기)로 뜬다. 덤프가 끝나지 못하면(실패·중단) 그 파일을 지우고 아무것도 바꾸지 않은 채 끝난다.
4. api·worker를 멈춘다. web·caddy는 그대로라 그동안 화면은 오류를 낸다(보통 1분 안).
5. 비운다: `docker compose run --rm --no-deps migrate node packages/db/dist/wipe-cli.js --yes`(`DATABASE_MIGRATE_URL` = `buddha_migrate`).
6. Redis를 비운다: `docker compose exec -T redis redis-cli FLUSHALL`.
7. `docker compose run --rm migrate`: 남은 마이그레이션(보통 없다)과 시드.
8. `docker compose up -d --wait`로 api·worker를 다시 띄운다.
9. 여기까지 모두 성공했으면 3단계의 덤프를 지운다(오너 결정, ADR-0048). 앞서 실패한 실행이 남긴 덤프가 `/data`에 있으면 그 이름을 알리고 지우지 않는다.

**확인.**

- `https://buddha.sboh.dev/api/health`가 200이다. 7단계의 시드 로그가 `admin … created`, `markets: 14 inserted`를 찍는다.
- 시드 관리자로 로그인 → `/onboarding`(실명·휴대전화) → `/admin/markets`에 초안 14개가 있다. 시드가 마감이 지났거나 14일 안에 마감되는 초안을 경고하면 관리자가 마감 시각을 고치거나 시드 문안을 새로 만든다.
- 테스터 계정으로 가입하면 가입 지급이 원장에 한 줄 생긴다.

**실패하면.** 스크립트는 첫 오류(또는 SSM 세션이 끊기는 등의 중단)에서 멈추고, 3단계의 덤프를 지우지 않은 채 그 경로를 알린다. 4단계 뒤라면 api·worker가 멈춘 채로 남는다. 5단계(비우기)가 끝나기 전이면 데이터는 그대로이니 `sudo docker compose -f /data/buddha/compose.yaml up -d`로 되돌린다. 그 뒤라면 원인을 고친 뒤 스크립트를 다시 돌린다 — 다시 돌려도 안전하다(빈 DB를 덤프하고 다시 비운 뒤 시드한다). 다시 돈 실행이 성공하면 지우는 것은 그 실행이 뜬 덤프뿐이고, 실패한 실행의 덤프는 남는다(스크립트가 끝에 이름을 알린다). 초기화 전 상태로 되돌리려면 실패한 실행의 덤프를 [terraform/README.md](../terraform/README.md#수동-pg_dump) 「수동 pg_dump」의 실제 복구 절차로 넣고, Redis는 비운 채로 둔다(워커의 매 분 스캔이 마감·정산을 다시 잡는다).

**덤프 정리.** 덤프에는 테스터의 이메일·실명·휴대전화가 들어 있다. 성공한 실행은 자기 덤프를 스스로 지운다. 실패한 실행이 남긴 덤프는 복구나 재실행의 성공을 확인한 뒤 손으로 지운다(`sudo rm /data/buddha-pre-reset-<시각>.dump`). `/data`에 있는 동안은 일일 스냅샷(7개)에도 들어간다.

## #125 배포 때의 한 번 (마이그레이션 0017)

#125를 머지하면 평소 배포가 그대로 초기화한다: `deploy.sh`의 `migrate`가 0017을 적용하고(비우기 → 직접 AMM 열·enum 값 삭제) 시드가 다시 채운 뒤 컨테이너를 바꾼다. 따로 할 일은 없다.

- drizzle은 남은 마이그레이션을 한 트랜잭션에서 적용한다. 0017이 실패하면 아무것도 지워지지 않고, 이전 릴리스가 계속 돈다(`deploy.sh`가 `migrate` 실패에서 멈춘다).
- 배포 창: `migrate`가 도는 수십 초 동안 이전 api·워커가 지운 열을 읽어 500·잡 실패를 낸다. 새 컨테이너가 뜨면 풀린다(ADR-0046 D3과 같다).
- 덤프는 자동으로 남지 않는다. 남기려면 머지 전에 [terraform/README.md](../terraform/README.md#수동-pg_dump)의 「수동 pg_dump」를 한다.
- 0017은 Redis를 건드리지 않는다. 지운 시장을 가리키던 지연 잡(`market.close`·`market.finalize`)은 워커에서 'not found'로 세 번 실패하고 버려진다. 데이터에는 영향이 없다. 로그까지 깨끗이 하려면 배포 직후, 테스터가 다시 가입하기 전에 위 스크립트를 한 번 돌린다. #149의 리허설도 된다.

## 로컬 개발 환경

개발 DB도 0017을 적용하는 다음 `pnpm db:migrate`에서 한 번 비워진다(시험 DB는 원래 시험마다 비운다). 개발 Redis에 남은 지연 잡도 위처럼 실패하고 버려진다.

같은 초기화를 로컬에서 하려면 `pnpm dev`를 멈추고 다음을 돌린다. `wipe-cli`는 `@buddha/shared` 빌드가 있어야 한다(`pnpm build`나 `pnpm dev`를 한 번 돌렸으면 된다).

```bash
pnpm --filter @buddha/db run db:wipe --yes   # .env의 DATABASE_MIGRATE_URL
docker compose exec redis redis-cli FLUSHALL
pnpm db:migrate && pnpm db:seed
```

볼륨째 지우는 `docker compose down -v`도 된다. 이때는 롤 초기화 SQL부터 다시 돈다.
