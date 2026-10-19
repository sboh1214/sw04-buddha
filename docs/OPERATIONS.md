# 운영 절차

배포 환경(buddha.sboh.dev)에서 운영자가 화면 없이 DB에서 손으로 하는 일의 절차다. 운영 DB 초기화는 [RESET.md](RESET.md), 셸·시크릿·덤프 같은 인프라 일은 [terraform/README.md](../terraform/README.md)에 있다.

## 회원의 휴대전화 번호 바꾸기 (#57 3항)

회원은 본인확인한 번호를 스스로 바꿀 수 없고 운영 문의로만 바꾼다. 운영자의 처리 기능은 만들지 않고 DB에서 직접 한다(ADR-0069 결정 1 #57 3항). 번호를 바꿀 때는 **새 번호도 '시작 Coin을 받은 번호'로 기록한다**(오너 결정 2026-10-18, ADR-0071). 그러지 않으면 그 회원이 탈퇴한 뒤 새 번호로 본인확인한 계정이 시작 Coin을 한 번 더 받는다. 옛 번호의 기록도 그대로 남으므로, 그 회원의 지급을 지급한 뒤에는 옛 번호도 새 번호도 다시 받지 못한다. 지급이 아직 금액을 기다리는 동안에는 다르다: 그 회원이 기다리는 동안 탈퇴하면 지급이 취소되고, 그 지급의 번호가 옛 번호와 여기서 기록한 새 번호까지 모두 풀린다. 지급된 적이 없으므로 그 번호들은 번호당 한 번을 쓰지 않은 것으로 보고, 다음에 그 번호로 본인확인한 계정은 받을 수 있다(오너 결정 2026-10-18의 답 2, ADR-0071 7-21).

요청한 사람이 그 회원인지, 새 번호가 그 사람의 것인지 확인하는 방법은 아직 정하지 않았다(ADR-0071 결과 4). 아래는 그 확인을 마친 뒤 DB에서 하는 일이다.

**바뀌는 것.**

- `phone_verifications`에서 그 계정 행의 `phone`이 새 번호가 된다. 테이블의 UNIQUE·CHECK가 지킨다: 다른 계정이 본인확인한 번호이거나 숫자만의 휴대전화 번호(01X)가 아니면 실패하고 아무것도 바뀌지 않는다. `verified_at`(회원이 인증번호로 확인한 때)은 그대로다.
- 그 계정에 시작 Coin의 지급 기록(`start_grants`, 지급했든 금액을 기다리든)이 있으면, 새 번호의 키 있는 해시를 그 지급의 번호로 기록한다(`start_grant_numbers`, `source` `operator`). 계정의 지급은 여전히 하나이고, 그 지급의 번호가 둘이 된다. 그 지급이 금액을 기다리는 동안 그 계정이 탈퇴하면, 이 번호도 그 지급의 다른 번호와 함께 풀린다(답 2).
- 지급 기록이 없으면(온보딩 전이거나, 본인확인한 번호가 이미 받은 번호여서 받지 못한 계정) 기록할 것이 없다. 나중에 그 계정의 지급이 그때의 번호, 곧 새 번호로 기록된다. 새 번호가 그때 다른 지급의 번호이면 그 계정의 지급은 기록되지 않는다(`number_already_used`, 아래 표).
- 새 번호가 이미 다른 계정의 지급의 번호이면 기록하지 않는다 — 번호마다 붙든 행은 하나다. 그 지급을 지급했으면(그 번호로 시작 Coin을 받은 계정이 탈퇴했거나, 운영자가 그 계정의 번호를 바꿨다) 이미 받은 번호라 빠진 것이 없다. 그 지급이 아직 금액을 기다리면(운영자가 그 계정의 번호를 바꿨다) 그 번호는 그 지급이 기다리는 동안만 받은 번호이고, 그 지급이 취소되면 이 계정의 것으로도 남지 않는다 — 아래 표의 `paid` = `f` 줄, 아직 정하지 않았다(ADR-0071 결과 4). 기다리다 탈퇴로 이미 취소된 지급의 번호는 풀려 있어 기록된다(답 2).
- 본인확인 발송 기록(`phone_verification_codes`)은 본인확인 기록이라 옛 번호를 그대로 담고 남는다(ADR-0070).

해시는 SQL로 셀 수 없다. 키(`PHONE_HASH_KEY`)가 있어야 하고, 키는 api 컨테이너의 환경에만 있다. 그래서 api 이미지의 해시 CLI(`apps/api/src/identity/phone-hash-cli.ts`)가 그 컨테이너 안에서 API와 같은 키·같은 함수(`phoneHash`)로 센다. CLI는 키를 찍지 않는다. 키를 컨테이너 밖으로 꺼내지 않는다.

**1. 셸.** `aws ssm start-session --profile inno-frame --target "$(terraform output -raw instance_id)"`([terraform/README.md](../terraform/README.md#셸)). 아래 명령은 모두 그 세션 안에서 한다.

**2. 새 번호의 해시.** api 컨테이너에서 CLI를 띄우고 새 번호를 입력한 뒤 Enter를 누른다(하이픈·공백이 있어도 된다). 번호는 명령줄이 아니라 입력으로 받으므로 셸 기록과 프로세스 목록에 남지 않는다.

```bash
sudo docker compose -f /data/buddha/compose.yaml exec api node apps/api/dist/identity/phone-hash-cli.js --psql
```

CLI는 psql에 그대로 붙여 넣을 두 줄을 찍고 끝난다. 두 값이 입력한 하나의 번호에서 나오므로 바꿀 번호와 기록할 해시가 어긋나지 않는다.

```text
\set new_phone '01098765432'
\set new_hash '<소문자 16진 64자>'
```

휴대전화 번호가 아니면 까닭을 알리고 다시 입력을 기다린다(그만두려면 Ctrl-D). 운영 API가 뜨지 못하는 환경(`PHONE_HASH_KEY`가 없거나 규칙에 맞지 않음)이면 CLI도 어느 변수가 무슨 규칙에 걸렸는지만 알리고 끝난다. `--psql` 없이 띄우면 한 줄에 번호 하나씩 받아 해시만 한 줄씩 찍는다.

**3. psql.** `buddha_app`으로 붙는다 — 앱과 같은 권한이라 앱이 지울 수 없는 표(`start_grants`·`start_grant_numbers` 등)는 손으로도 지우지 못한다. `PSQL_HISTORY=/dev/null`은 입력한 번호와 SQL이 psql 기록 파일에 남지 않게 한다.

```bash
sudo docker compose -f /data/buddha/compose.yaml exec -e PSQL_HISTORY=/dev/null postgres \
  psql -U buddha_app -d buddha
```

계정은 지금 번호나 이메일로 찾는다.

```sql
SELECT user_id, verified_at FROM phone_verifications WHERE phone = '01012345678';
SELECT id FROM "user" WHERE email = 'member@example.com';
```

**4. 바꾸고 기록하기.** 찾은 계정의 id와 2단계의 두 줄을 psql 변수로 넣는다.

```sql
\set user_id '<계정 id>'
\set new_phone '01098765432'
\set new_hash '<2단계가 찍은 값>'
```

그다음 한 트랜잭션으로 돌린다. 마지막 줄의 결과를 읽기 전에는 `COMMIT`하지 않는다.

```sql
BEGIN;
UPDATE phone_verifications SET phone = :'new_phone', updated_at = now()
  WHERE user_id = :'user_id';
INSERT INTO start_grant_numbers (phone_hash, grant_id, source)
  SELECT :'new_hash', g.id, 'operator' FROM start_grants g
  WHERE g.user_id = :'user_id' AND g.cancelled_at IS NULL
  ON CONFLICT DO NOTHING;
SELECT g.user_id = :'user_id' AS this_account, n.source, g.granted_at IS NOT NULL AS paid,
    EXISTS (SELECT 1 FROM start_grants o
      WHERE o.user_id = :'user_id' AND o.cancelled_at IS NULL) AS has_grant
  FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
  WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL;
```

결과를 읽는 법(같은 SQL이 `packages/db/src/phone-change.ts`에 있고, `phone-change.test.ts`가 이 문서의 SQL이 그것과 같은지와 아래 경우마다 그렇게 되는지를 시험한다). 마지막 줄의 칸: `this_account`는 새 번호를 붙든 지급이 이 계정의 것인지, `paid`는 그 지급을 지급했는지(`f`면 금액을 기다린다), `has_grant`는 이 계정에 취소되지 않은 지급 기록이 있는지다.

| 결과                                                                                  | 뜻                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 다음                                                                |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `UPDATE 0`                                                                            | 그 id의 본인확인 기록이 없다(id가 틀렸거나 본인확인 전·탈퇴한 계정).                                                                                                                                                                                                                                                                                                                                                                                  | `ROLLBACK;`                                                         |
| 오류(23505 `phone_verifications_phone_unique`)                                        | 새 번호는 다른 계정이 본인확인한 번호다. 트랜잭션이 깨졌다.                                                                                                                                                                                                                                                                                                                                                                                           | `ROLLBACK;`                                                         |
| `UPDATE 1`, `INSERT 0 1`, 한 줄 `this_account` = `t`                                  | 번호를 바꾸고 새 번호를 이 계정의 지급의 번호로 기록했다(`source` `operator`). `paid` = `f`이면 그 지급은 금액을 기다리고, 이 계정이 기다리는 동안 탈퇴하면 옛 번호와 함께 이 번호도 풀린다(답 2).                                                                                                                                                                                                                                                    | `COMMIT;`                                                           |
| `UPDATE 1`, `INSERT 0 0`, 한 줄 `this_account` = `t`                                  | 새 번호가 이미 이 계정의 지급의 번호다(같은 일을 다시 했거나, 그 지급에 이미 기록된 예전 번호로 되돌렸다).                                                                                                                                                                                                                                                                                                                                            | `COMMIT;`                                                           |
| `UPDATE 1`, `INSERT 0 0`, 한 줄 `this_account` = `f`, `paid` = `t`, `has_grant` = `t` | 새 번호는 다른 계정이 시작 Coin을 받은 번호다(그 계정이 탈퇴했거나, 운영자가 그 계정의 번호를 바꿨다). 이미 받은 번호라 빠진 것이 없다. 이 계정의 지급은 그대로다.                                                                                                                                                                                                                                                                                    | `COMMIT;`                                                           |
| `UPDATE 1`, `INSERT 0 0`, 한 줄 `this_account` = `f`, `paid` = `f`, `has_grant` = `t` | 새 번호는 금액을 기다리는 다른 계정의 지급이 붙들고 있다(운영자가 그 계정의 번호를 바꿨다). 이 계정의 지급에는 기록되지 않았다. 그 지급이 기다리는 동안만 받은 번호이고, 그 계정이 기다리는 동안 탈퇴하면 지급이 취소되어 번호가 풀린다(답 2). 그러면 이 번호는 어느 지급의 것도 아니어서, 이 계정이 시작 Coin을 받은 뒤 탈퇴하면 이 번호로 본인확인한 다음 계정이 또 받는다 — 답 3이 막으려는 일이다. 어떻게 할지 정하지 않았다(ADR-0071 결과 4).    | 정하기 전에는 `COMMIT`하지 않는다: `ROLLBACK;`하고 오너에게 묻는다. |
| `UPDATE 1`, `INSERT 0 0`, 한 줄 `this_account` = `f`, `has_grant` = `f`               | 이 계정에 지급 기록이 없고(온보딩 전이거나 이미 받은 번호로 본인확인한 계정), 새 번호는 다른 계정의 지급의 번호다. 그 행이 붙들고 있는 동안 이 계정은 이 번호로 시작 Coin을 받지 못한다 — 나중의 지급(#58)이 `number_already_used`로 끝나고 아무것도 기록하지 않는다. 옛 번호로는 받았을 수 있다. `paid` = `f`이고 그 지급이 먼저 취소되면 이 계정의 지급이 이 번호를 기록한다. 회원에게 알릴지, 이런 변경을 받을지는 정하지 않았다(ADR-0071 결과 4). | `COMMIT;`                                                           |
| `UPDATE 1`, `INSERT 0 0`, 줄 없음                                                     | 이 계정에 지급 기록이 없다(온보딩 전이거나 이미 받은 번호로 본인확인한 계정). 나중에 그 지급이 새 번호로 기록된다.                                                                                                                                                                                                                                                                                                                                    | `COMMIT;`                                                           |

`COMMIT`한 뒤 그 계정의 번호 기록을 본다. 지급의 원래 번호(`grant`)와 이번에 기록한 번호(`operator`)가 보인다. `released_at`이 찬 행은 그 지급이 기다리다 취소되어 풀린 번호다(답 2).

```sql
SELECT n.source, n.created_at, n.released_at
  FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
  WHERE g.user_id = :'user_id' ORDER BY n.created_at;
```

**하지 않는 것.**

- `start_grants`·`start_grant_numbers`의 행을 지우거나 고치지 않는다. `UPDATE start_grants`는 손으로 돌리지 않는다. 지운 번호는 다시 시작 Coin을 받는다. `buddha_app`은 지울 수 없고, 트리거는 '기다림 → 지급'(그 지급 자신의 `START_GRANT` 원장 행으로만)과 '기다림 → 취소' 밖의 변경을 모두 거절한다. 그러나 기다리는 지급의 취소는 어느 UPDATE에서 와도 받는다: `cancelled_at`을 채우면 그 지급의 번호가 모두(운영자가 기록한 것도) 풀려 다음 계정이 다시 시작 Coin을 받고, 그 계정은 탈퇴하지 않았어도 다시는 지급 기록을 만들지 못한다(계정마다 하나, 취소된 행은 바뀌지 않는다). 취소는 탈퇴(#140, `cancelStartGrant`)만 한다. 슈퍼유저(`postgres`)로 붙으면 지울 수도 있으니 그 롤로 이 절차를 하지 않는다.
- 해시를 다른 곳에서 세지 않는다. 다른 키로 센 해시는 어느 번호와도 맞지 않아 기록해도 아무것도 막지 못한다.
- 번호의 기록은 번호를 바꾼 계정의 지급에만 더한다. 탈퇴로 취소된 지급(금액을 기다리다 탈퇴한 계정, ADR-0071)에는 더할 수 없다 — 트리거가 거절한다.

**로컬.** 같은 일을 개발 스택에서 해 보려면, `.env`의 `PHONE_HASH_KEY`(비워 두면 개발용 키)로 해시를 세고 개발 DB에 붙는다.

```bash
corepack pnpm --filter api build
corepack pnpm --filter api run phone-hash --psql
docker compose exec -e PSQL_HISTORY=/dev/null postgres psql -U buddha_app -d buddha
```
