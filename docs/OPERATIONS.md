# 운영 절차

배포 환경(buddha.sboh.dev)에서 운영자가 화면 없이 DB에서 손으로 하는 일의 절차다. 운영 DB 초기화는 [RESET.md](RESET.md), 셸·시크릿·덤프 같은 인프라 일은 [terraform/README.md](../terraform/README.md)에 있다.

## 회원의 휴대전화 번호 바꾸기 (#57 3항)

회원은 본인확인한 번호를 스스로 바꿀 수 없고 운영 문의로만 바꾼다. 운영자의 처리 기능은 만들지 않고 DB에서 직접 한다(ADR-0069 결정 1 #57 3항). 번호를 바꿀 때는 **새 번호도 '시작 Coin을 받은 번호'로 기록한다**(오너 결정 2026-10-18, ADR-0071). 그러지 않으면 그 회원이 탈퇴한 뒤 새 번호로 본인확인한 계정이 시작 Coin을 한 번 더 받는다. 옛 번호의 기록도 그대로 남으므로, 그 회원의 지급을 지급한 뒤에는 옛 번호도 새 번호도 다시 받지 못한다. 지급이 아직 금액을 기다리는 동안에는 다르다: 그 회원이 기다리는 동안 탈퇴하면 지급이 취소되고, 그 지급의 번호가 옛 번호와 여기서 기록한 새 번호까지 모두 풀린다. 지급된 적이 없으므로 그 번호들은 번호당 한 번을 쓰지 않은 것으로 보고, 다음에 그 번호로 본인확인한 계정은 받을 수 있다(오너 결정 2026-10-18의 답 2, ADR-0071 7-21).

요청한 사람이 그 회원인지와 새 번호가 그 사람의 것인지는 1단계에서 확인한다(오너 결정 2026-10-19, ADR-0071). 보낸 주소의 계정을 먼저 찾고, 그 계정이 있을 때만 새 번호로 확인 문자를 보낸다. 그 확인을 마치지 않은 요청으로는 아무것도 바꾸지 않는다.

**바뀌는 것.**

- `phone_verifications`에서 그 계정 행의 `phone`이 새 번호가 된다. 테이블의 UNIQUE·CHECK가 지킨다: 다른 계정이 본인확인한 번호이거나 숫자만의 휴대전화 번호(01X)가 아니면 실패하고 아무것도 바뀌지 않는다. `verified_at`(회원이 인증번호로 확인한 때)은 그대로다.
- 그 계정에 시작 Coin의 지급 기록(`start_grants`, 지급했든 금액을 기다리든)이 있으면, 새 번호의 키 있는 해시를 그 지급의 번호로 기록한다(`start_grant_numbers`, `source` `operator`). 계정의 지급은 여전히 하나이고, 그 지급의 번호가 둘이 된다. 그 지급이 금액을 기다리는 동안 그 계정이 탈퇴하면, 이 번호도 그 지급의 다른 번호와 함께 풀린다(답 2).
- 지급 기록이 없으면(온보딩 전이거나, 본인확인한 번호가 이미 받은 번호여서 받지 못한 계정) 기록할 것이 없다. 그 계정의 지급은 지급 기능이 불릴 때(#58, 온보딩을 마칠 때) 그때의 번호, 곧 새 번호로 기록된다 — 이미 받은 번호여서 받지 못한 계정은 그 단계를 지났으므로 그 기능이 다시 불릴 때만이다(ADR-0071 결과 4). 새 번호가 그때 다른 지급의 번호이면 그 계정의 지급은 기록되지 않는다(`number_already_used`). 새 번호가 이미 시작 Coin을 받은 번호(지급한 다른 지급의 번호)이면 바꾸고, 회원에게 그 번호로는 이미 시작 Coin을 받아 그 계정은 받지 못한다고 알린다(오너 결정 2026-10-19, 아래 표). 금액을 기다리는 다른 지급이 붙든 번호로는 바꾸지 않는다(다음 항목).
- 새 번호가 이미 다른 계정의 지급의 번호이면 이 계정의 지급에 기록하지 않는다 — 번호마다 붙든 행은 하나다. 그 지급을 지급했으면(그 번호로 시작 Coin을 받은 계정이 탈퇴했거나, 운영자가 그 계정의 번호를 바꿨다) 이미 받은 번호라 빠진 것이 없다. 그 지급이 아직 금액을 기다리면(운영자가 그 계정의 번호를 바꿨다) 이 계정에 지급 기록이 있든 없든 **번호를 바꾸지 않는다**(오너 결정 2026-10-19). 그 번호는 그 지급이 기다리는 동안만 받은 번호라, 그 계정이 기다리다 탈퇴하면 풀린다(답 2). 지급 기록이 있는 계정을 그 번호로 바꾸면 이 계정이 받은 뒤 탈퇴했을 때 그 번호로 본인확인한 다음 계정이 또 받는다. 지급 기록이 없는 계정이면 그 번호로는 아직 아무도 받지 않았는데 회원에게 받지 못한다고 알리게 된다. 지급 기록이 있으면 5단계의 SQL이 오류로 거절하고, 없으면 SQL에는 더할 행이 없어 거절하지 않으므로 결과의 마지막 줄(`paid` = `f`)을 보고 `ROLLBACK`한다. 어느 쪽이든 그 지급이 지급되거나 취소된 뒤에 1단계부터 다시 한다(아래 표). 기다리다 탈퇴로 이미 취소된 지급의 번호는 풀려 있어 바꾼다(지급 기록이 있으면 기록된다, 답 2).
- 본인확인 발송 기록(`phone_verification_codes`)은 본인확인 기록이라 옛 번호를 그대로 담고 남는다(ADR-0070).

해시는 SQL로 셀 수 없다. 키(`PHONE_HASH_KEY`)가 있어야 하고, 키는 api 컨테이너의 환경에만 있다. 그래서 api 이미지의 해시 CLI(`apps/api/src/identity/phone-hash-cli.ts`)가 그 컨테이너 안에서 API와 같은 키·같은 함수(`phoneHash`)로 센다. CLI는 키를 찍지 않는다. 키를 컨테이너 밖으로 꺼내지 않는다.

**1. 요청 확인.** 두 가지를 이 순서로 모두 마친 요청만 처리한다(오너 결정 2026-10-19, ADR-0071 7-20).

먼저 보낸 주소의 계정을 찾는다. 요청은 그 계정의 가입 이메일(그 계정의 `user.email`)에서 보낸 것만 받고, 다른 주소에서 온 요청으로는 바꾸지 않는다. 아무것도 보내기 전에 셸(2단계)에서 psql(4단계)로 붙어 요청을 보낸 주소로 찾는다 — 읽기만 한다. 계정의 이메일은 소문자로 저장되어 있다. 줄이 없으면 그 주소는 어느 계정의 가입 이메일도 아니고, `verified` = `f`이면 그 계정에 바꿀 본인확인 기록이 없다(본인확인 전이거나 탈퇴한 계정). 어느 쪽이든 여기서 그만둔다 — 문자를 보내지 않고 아무것도 바꾸지 않는다. 찾은 `id`는 5단계에서 쓴다. 회원의 답을 기다리는 동안 psql을 열어 두지 않는다.

```sql
\set sender 'member@example.com'
SELECT u.id, pv.user_id IS NOT NULL AS verified
  FROM "user" u LEFT JOIN phone_verifications pv ON pv.user_id = u.id
  WHERE u.email = lower(:'sender');
```

그 계정(`verified` = `t`)을 찾은 요청에만 새 번호로 확인 문자를 보내고, 회원이 그 문자에 답해 확인한 뒤에만 다음 단계로 간다. 문자는 알리고 콘솔 같은 곳에서 손으로 보낸다 — 회원이 번호를 바꾸는 화면이 없으므로 앱의 본인확인 문자는 쓸 수 없다. 손으로 보낸 문자는 앱의 발송 기록(`phone_verification_codes`)과 발송 한도, `/admin/sms`의 수에 들지 않는다.

**2. 셸.** `aws ssm start-session --profile inno-frame --target "$(terraform output -raw instance_id)"`([terraform/README.md](../terraform/README.md#셸)). 아래 명령은 모두 그 세션 안에서 한다.

**3. 새 번호의 해시.** api 컨테이너에서 CLI를 띄우고 새 번호를 입력한 뒤 Enter를 누른다(하이픈·공백이 있어도 된다). 번호는 명령줄이 아니라 입력으로 받으므로 셸 기록과 프로세스 목록에 남지 않는다.

```bash
sudo docker compose -f /data/buddha/compose.yaml exec api node apps/api/dist/identity/phone-hash-cli.js --psql
```

CLI는 psql에 그대로 붙여 넣을 두 줄을 찍고 끝난다. 두 값이 입력한 하나의 번호에서 나오므로 바꿀 번호와 기록할 해시가 어긋나지 않는다.

```text
\set new_phone '01098765432'
\set new_hash '<소문자 16진 64자>'
```

휴대전화 번호가 아니면 까닭을 알리고 다시 입력을 기다린다(그만두려면 Ctrl-D). 운영 API가 뜨지 못하는 환경(`PHONE_HASH_KEY`가 없거나 규칙에 맞지 않음)이면 CLI도 어느 변수가 무슨 규칙에 걸렸는지만 알리고 끝난다. `--psql` 없이 띄우면 한 줄에 번호 하나씩 받아 해시만 한 줄씩 찍는다.

**4. psql.** `buddha_app`으로 붙는다 — 앱과 같은 권한이라 앱이 지울 수 없는 표(`start_grants`·`start_grant_numbers` 등)는 손으로도 지우지 못한다. `PSQL_HISTORY=/dev/null`은 입력한 번호와 SQL이 psql 기록 파일에 남지 않게 한다.

```bash
sudo docker compose -f /data/buddha/compose.yaml exec -e PSQL_HISTORY=/dev/null postgres \
  psql -U buddha_app -d buddha
```

**5. 바꾸고 기록하기.** 1단계에서 찾은 계정의 id와 3단계의 두 줄을 psql 변수로 넣는다. `ON_ERROR_ROLLBACK`은 끈다(psql의 기본값이지만 `.psqlrc`가 켰을 수 있다). 켜져 있으면 psql이 오류 난 문장만 되돌리고 트랜잭션을 이어 가서, 아래의 거절(오류) 뒤의 `COMMIT`이 기록 없이 번호만 바꾼다. 꺼져 있으면 오류가 트랜잭션 전체를 깨서 `COMMIT`도 `ROLLBACK`이 된다.

```sql
\set user_id '<계정 id>'
\set new_phone '01098765432'
\set new_hash '<3단계가 찍은 값>'
\set ON_ERROR_ROLLBACK off
```

그다음 한 트랜잭션으로 돌린다. 마지막 줄의 결과를 읽기 전에는 `COMMIT`하지 않는다.

```sql
BEGIN;
UPDATE phone_verifications SET phone = :'new_phone', updated_at = now()
  WHERE user_id = :'user_id';
INSERT INTO start_grant_numbers (phone_hash, grant_id, source)
  SELECT :'new_hash', g.id, 'operator' FROM start_grants g
  WHERE g.user_id = :'user_id' AND g.cancelled_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM start_grant_numbers n JOIN start_grants h ON h.id = n.grant_id
      WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL
        AND (h.id = g.id OR h.granted_at IS NOT NULL));
SELECT g.user_id = :'user_id' AS this_account, n.source, g.granted_at IS NOT NULL AS paid,
    EXISTS (SELECT 1 FROM start_grants o
      WHERE o.user_id = :'user_id' AND o.cancelled_at IS NULL) AS has_grant
  FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
  WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL;
```

결과를 읽는 법(같은 SQL이 `packages/db/src/phone-change.ts`에 있고, `phone-change.test.ts`가 이 문서의 SQL이 그것과 같은지와 아래 경우마다 psql처럼 돌려 그렇게 되는지를 시험한다 — 결과마다 아래 표의 한 줄만 맞고, 그 줄의 '다음'이 말하는 `COMMIT`이나 `ROLLBACK`으로 끝낸다). `INSERT`는 새 번호를 이 계정의 지급(취소되지 않은 것)에 더한다. 새 번호를 이미 이 지급이나 지급한 지급이 붙들고 있으면 건너뛰고(`INSERT 0 0`), 금액을 기다리는 다른 지급이 붙들고 있으면 건너뛰지 않는다 — 번호마다 붙든 행은 하나라(`start_grant_numbers_phone_hash_live_idx`) 그 `INSERT`가 오류로 끝나 트랜잭션이 깨진다. 그것이 바꾸지 않는 경우의 거절이다(오너 결정 2026-10-19). 이 계정에 지급 기록이 없으면 더할 행이 없어 SQL은 거절하지 않는다 — 그때는 마지막 줄의 `paid`를 보고 운영자가 `ROLLBACK`한다(아래 표). 마지막 줄의 칸: `this_account`는 새 번호를 붙든 지급이 이 계정의 것인지, `paid`는 그 지급을 지급했는지(`f`면 금액을 기다린다), `has_grant`는 이 계정에 취소되지 않은 지급 기록이 있는지다. 한 문장이 오류로 끝나면 그 뒤의 문장도 `current transaction is aborted`(25P02)로 돌지 않으므로, 표에서는 첫 오류의 줄을 찾는다.

| 결과                                                                                  | 뜻                                                                                                                                                                                                                                                                                                                                                                                                                           | 다음                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPDATE 0`                                                                            | 그 id의 본인확인 기록이 없다(id가 틀렸거나 본인확인 전·탈퇴한 계정).                                                                                                                                                                                                                                                                                                                                                         | `ROLLBACK;`                                                                                                                                                                                                                                                                                                       |
| `UPDATE`에서 오류(23505 `phone_verifications_phone_unique`)                           | 새 번호는 다른 계정이 본인확인한 번호다. 트랜잭션이 깨졌다.                                                                                                                                                                                                                                                                                                                                                                  | `ROLLBACK;`                                                                                                                                                                                                                                                                                                       |
| `INSERT`에서 오류(23505 `start_grant_numbers_phone_hash_live_idx`)                    | 새 번호는 금액을 기다리는 다른 계정의 지급이 붙들고 있다(운영자가 그 계정의 번호를 바꿨다). 그 지급이 기다리는 동안만 받은 번호라, 그 계정이 기다리다 탈퇴하면 지급이 취소되어 번호가 풀린다(답 2). 바꾸면 이 계정이 시작 Coin을 받은 뒤 탈퇴했을 때 이 번호로 본인확인한 다음 계정이 또 받으므로 **바꾸지 않는다**(오너 결정 2026-10-19). SQL이 거절해 트랜잭션이 깨졌고 아무것도 바뀌지 않았다.                            | `ROLLBACK;`(`COMMIT`해도 `ROLLBACK`이 된다). 회원에게 지금은 그 번호로 바꿀 수 없다고 알린다. 그 지급이 지급되거나(시작 지급액이 들어가면 1분 안) 취소된(그 계정이 탈퇴한) 뒤에 1단계부터 다시 한다(아래 '거절된 변경을 다시 할 때'). 그 전에 같은 SQL을 다시 돌려도 같은 오류로 거절되고 아무것도 바뀌지 않는다. |
| `UPDATE 1`, `INSERT 0 1`, 한 줄 `this_account` = `t`                                  | 번호를 바꾸고 새 번호를 이 계정의 지급의 번호로 기록했다(`source` `operator`). `paid` = `f`이면 그 지급은 금액을 기다리고, 이 계정이 기다리는 동안 탈퇴하면 옛 번호와 함께 이 번호도 풀린다(답 2).                                                                                                                                                                                                                           | `COMMIT;`                                                                                                                                                                                                                                                                                                         |
| `UPDATE 1`, `INSERT 0 0`, 한 줄 `this_account` = `t`                                  | 새 번호가 이미 이 계정의 지급의 번호다(같은 일을 다시 했거나, 그 지급에 이미 기록된 예전 번호로 되돌렸다).                                                                                                                                                                                                                                                                                                                   | `COMMIT;`                                                                                                                                                                                                                                                                                                         |
| `UPDATE 1`, `INSERT 0 0`, 한 줄 `this_account` = `f`, `paid` = `t`, `has_grant` = `t` | 새 번호는 다른 계정이 시작 Coin을 받은 번호다(그 계정이 탈퇴했거나, 운영자가 그 계정의 번호를 바꿨다). 이미 받은 번호라 빠진 것이 없다. 이 계정의 지급은 그대로다. 그 다른 지급이 아직 기다리면 이 줄이 아니라 위의 `INSERT` 오류다.                                                                                                                                                                                         | `COMMIT;`                                                                                                                                                                                                                                                                                                         |
| `UPDATE 1`, `INSERT 0 0`, 한 줄 `this_account` = `f`, `paid` = `t`, `has_grant` = `f` | 이 계정에 지급 기록이 없고(온보딩 전이거나 이미 받은 번호로 본인확인한 계정), 새 번호는 다른 계정이 시작 Coin을 받은 번호다(그 계정이 탈퇴했거나, 운영자가 그 계정의 번호를 바꿨다). 그 행이 붙들고 있는 동안 이 계정은 이 번호로 시작 Coin을 받지 못한다 — 나중의 지급(#58)이 `number_already_used`로 끝나고 아무것도 기록하지 않는다. 옛 번호로는 받았을 수 있다.                                                          | `COMMIT;`. 회원에게 번호를 바꿨다고 알릴 때, 이 번호로는 이미 시작 Coin을 받아 이 계정은 시작 Coin을 받지 못한다고 함께 알린다(오너 결정 2026-10-19).                                                                                                                                                             |
| `UPDATE 1`, `INSERT 0 0`, 한 줄 `this_account` = `f`, `paid` = `f`, `has_grant` = `f` | 이 계정에 지급 기록이 없고, 새 번호는 금액을 기다리는 다른 계정의 지급이 붙들고 있다(운영자가 그 계정의 번호를 바꿨다). 그 번호로는 아직 아무도 시작 Coin을 받지 않았다 — 그 지급이 지급되면 받은 번호가 되고, 그 계정이 기다리다 탈퇴하면 풀린다(답 2). 이 계정에는 더할 지급이 없어 SQL이 거절하지 않았지만, 이것도 기다리는 다른 지급이 붙든 번호로 바꾸는 것이라 **바꾸지 않는다**(오너 결정 2026-10-19, ADR-0071 7-26). | `ROLLBACK;` — `COMMIT`하면 번호가 바뀐다. 회원에게 지금은 그 번호로 바꿀 수 없다고 알린다. 위의 `INSERT` 오류와 같이 그 지급이 지급되거나 취소된 뒤에 1단계부터 다시 한다(아래 '거절된 변경을 다시 할 때').                                                                                                       |
| `UPDATE 1`, `INSERT 0 0`, 줄 없음                                                     | 이 계정에 지급 기록이 없다(온보딩 전이거나 이미 받은 번호로 본인확인한 계정). 그 계정의 지급이 기록될 때(#58) 새 번호로 기록된다 — 이미 받은 번호로 본인확인한 계정은 지급 기능이 다시 불릴 때만이다(ADR-0071 결과 4).                                                                                                                                                                                                       | `COMMIT;`                                                                                                                                                                                                                                                                                                         |

`COMMIT`한 뒤 그 계정의 번호 기록을 본다. 지급의 원래 번호(`grant`)와 이번에 기록한 번호(`operator`)가 보인다. `released_at`이 찬 행은 그 지급이 기다리다 취소되어 풀린 번호다(답 2).

```sql
SELECT n.source, n.created_at, n.released_at
  FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
  WHERE g.user_id = :'user_id' ORDER BY n.created_at;
```

**거절된 변경을 다시 할 때.** 결과 표의 두 거절(`INSERT` 오류, `paid` = `f`·`has_grant` = `f`)은 그 번호를 붙든 지급이 정해진 뒤에만 다시 한다. 다시 하기 전에 그 지급이 정해졌는지 읽기만 하는 조회로 본다(3단계의 `new_hash` 줄을 넣은 psql에서). `paid` = `f`이면 아직 기다린다 — 다시 해도 거절된다. `paid` = `t`이거나(지급됐다) 줄이 없으면(취소되어 번호가 풀렸다) 정해졌다. 다시 할 때는 1단계부터 다시 한다: 보낸 주소의 계정을 다시 찾고, 새 번호로 확인 문자를 다시 보내 회원의 답을 받는다. 거절 전에 받은 확인으로 다시 하지 않는다 — 그 지급이 정해지기까지는 기한이 없어(시작 지급액이 들어가거나 그 계정이 탈퇴할 때까지) 그 사이에 번호의 주인이 바뀌었을 수 있다(ADR-0071 7-28).

```sql
SELECT g.granted_at IS NOT NULL AS paid
  FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
  WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL;
```

**하지 않는 것.**

- `start_grants`·`start_grant_numbers`의 행을 지우거나 고치지 않는다. `UPDATE start_grants`는 손으로 돌리지 않는다. 지운 번호는 다시 시작 Coin을 받는다. `buddha_app`은 지울 수 없고, 트리거는 '기다림 → 지급'(그 지급 자신의 `START_GRANT` 원장 행으로만)과 '기다림 → 취소' 밖의 변경을 모두 거절한다. 그러나 기다리는 지급의 취소는 어느 UPDATE에서 와도 받는다: `cancelled_at`을 채우면 그 지급의 번호가 모두(운영자가 기록한 것도) 풀려 다음 계정이 다시 시작 Coin을 받고, 그 계정은 탈퇴하지 않았어도 다시는 지급 기록을 만들지 못한다(계정마다 하나, 취소된 행은 바뀌지 않는다). 취소는 탈퇴(#140, `cancelStartGrant`)만 한다. 슈퍼유저(`postgres`)로 붙으면 지울 수도 있으니 그 롤로 이 절차를 하지 않는다.
- 5단계의 문장을 나눠 돌리지 않는다. `UPDATE`만 돌리면 새 번호가 받은 번호로 기록되지 않고, `INSERT`가 거절한 변경(기다리는 다른 지급의 번호)도 그대로 들어간다. 거절된 변경은 그 지급이 정해진 뒤 1단계부터 다시 한다 — 거절 전에 받은 확인으로 5단계만 다시 하지 않는다.
- 해시를 다른 곳에서 세지 않는다. 다른 키로 센 해시는 어느 번호와도 맞지 않아 기록해도 아무것도 막지 못한다.
- 번호의 기록은 번호를 바꾼 계정의 지급에만 더한다. 탈퇴로 취소된 지급(금액을 기다리다 탈퇴한 계정, ADR-0071)에는 더할 수 없다 — 트리거가 거절한다.

**로컬.** 같은 일을 개발 스택에서 해 보려면, `.env`의 `PHONE_HASH_KEY`(비워 두면 개발용 키)로 해시를 세고 개발 DB에 붙는다.

```bash
corepack pnpm --filter api build
corepack pnpm --filter api run phone-hash --psql
docker compose exec -e PSQL_HISTORY=/dev/null postgres psql -U buddha_app -d buddha
```
