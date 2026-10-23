# 운영 절차

배포 환경(buddha.sboh.dev)에서 운영자가 앱의 화면 없이 손으로 하는 일 — DB에서 하는 일과 고객센터 이메일로 받는 일 — 과 API 컨테이너의 메모리 확인의 절차다. 운영 DB 초기화는 [RESET.md](RESET.md), 셸·시크릿·덤프 같은 인프라 일은 [terraform/README.md](../terraform/README.md)에 있다.

## 회원의 휴대전화 번호 바꾸기 (#57 3항)

회원은 본인확인한 번호를 스스로 바꿀 수 없고 운영 문의로만 바꾼다. 운영자의 처리 기능은 만들지 않고 DB에서 직접 한다(ADR-0069 결정 1 #57 3항). 번호를 바꿀 때는 **새 번호도 '시작 Coin을 받은 번호'로 기록한다**(오너 결정 2026-10-18, ADR-0071). 그러지 않으면 그 회원이 탈퇴한 뒤 새 번호로 본인확인한 계정이 시작 Coin을 한 번 더 받는다. 옛 번호의 기록도 그대로 남으므로, 그 회원의 지급을 지급한 뒤에는 옛 번호도 새 번호도 다시 받지 못한다. 지급이 아직 금액을 기다리는 동안에는 다르다: 그 회원이 기다리는 동안 탈퇴하면 지급이 취소되고, 그 지급의 번호가 옛 번호와 여기서 기록한 새 번호까지 모두 풀린다. 지급된 적이 없으므로 그 번호들은 번호당 한 번을 쓰지 않은 것으로 보고, 다음에 그 번호로 본인확인한 계정은 받을 수 있다(오너 결정 2026-10-18의 답 2, ADR-0071 7-21). 다만 그 지급이 기다리는 동안에는 옛 번호도 그 지급의 번호다. 그 사이에 앱에서 옛 번호로 본인확인하고 온보딩한 다른 계정은 시작 Coin을 받지 못하고(`number_already_used`, 기록 없음), 뒤에 그 회원이 기다리다 탈퇴해 번호가 풀려도 저절로 받지 않는다 — 오너가 그대로 받아들였다(오너 결정 2026-10-19 3차의 답 4, ADR-0071). 그 계정의 지급은 이미 받은 번호와 같은 답(`number_already_used`)으로 끝나지만 그 번호로는 아직 아무도 시작 Coin을 받지 않았다 — 그래서 그 계정에 보일 안내는 '이미 받았다'가 아니라 '이 번호로는 시작 Coin을 받을 수 없습니다'이고, 그 안내는 온보딩(#58)이 그린다(오너 결정 2026-10-19 4차의 답 3, ADR-0071 결과 5).

요청한 사람이 그 회원인지와 새 번호가 그 사람의 것인지는 1단계에서 확인한다(오너 결정 2026-10-19와 그 3차·4차, ADR-0071). 요청 메일이 그 계정의 지금 이메일에서 발신 인증을 통과해 왔는지 보고, 그 주소의 계정을 찾고, 새 번호를 5단계가 거절할지 미리 본 뒤에만 새 번호로 6자리 확인 번호를 문자로 보낸다. 회원이 그 번호를 30분 안에 같은 이메일에서 답장으로 보내 맞고, 답장의 주소로 다시 찾은 계정이 처음의 계정과 같을 때까지 아무것도 바꾸지 않는다.

**거절의 문장.** 번호 변경을 거절할 때는 언제나 회원에게 까닭 없이 이 한 문장만 알린다(오너 결정 2026-10-19 4차의 답 1). 1단계에서 찾은 계정에 본인확인 기록이 없을 때, 사전 확인이 새 번호를 거를 때, 답장의 주소로 다시 찾은 계정이 처음과 다를 때(그 사이에 이메일을 바꿨다), 확인 번호를 세 번 보내도 맞는 답이 오지 않을 때, 5단계가 거절할 때(결과 표의 `ROLLBACK` 줄) 모두 같다. 받는 사람은 1단계에서 계정을 찾은 주소다. 어느 계정의 가입 이메일도 아닌 주소에서 왔거나 발신 인증을 통과하지 못한 요청에 회신할지는 정하지 않았다(ADR-0071 결과 4).

```text
지금은 그 번호로 바꿀 수 없습니다
```

**바뀌는 것.**

- `phone_verifications`에서 그 계정 행의 `phone`이 새 번호가 된다. 테이블의 UNIQUE·CHECK가 지킨다: 다른 계정이 본인확인한 번호이거나 숫자만의 휴대전화 번호(01X)가 아니면 실패하고 아무것도 바뀌지 않는다. 다른 계정이 본인확인한 번호는 1단계의 사전 확인이 확인 문자를 보내기 전에 거르고, 그 뒤에 다른 계정이 본인확인해 여기서 실패하면 회원에게 거절의 문장만 알린다(오너 결정 2026-10-19 4차의 답 1). `verified_at`(회원이 인증번호로 확인한 때)은 그대로다.
- 그 계정에 시작 Coin의 지급 기록(`start_grants`, 지급했든 금액을 기다리든)이 있으면, 새 번호의 키 있는 해시를 그 지급의 번호로 기록한다(`start_grant_numbers`, `source` `operator`). 계정의 지급은 여전히 하나이고, 그 지급의 번호가 둘이 된다. 그 지급이 금액을 기다리는 동안 그 계정이 탈퇴하면, 이 번호도 그 지급의 다른 번호와 함께 풀린다(답 2).
- 지급 기록이 없으면(온보딩 전이거나, 본인확인한 번호가 이미 받은 번호여서 받지 못한 계정) 기록할 것이 없다. 그 계정의 지급은 지급 기능이 불릴 때(#58, 온보딩을 마칠 때) 그때의 번호, 곧 새 번호로 기록된다 — 이미 받은 번호여서 받지 못한 계정은 그 단계를 지났으므로 그 기능이 다시 불릴 때만이다(ADR-0071 결과 4). 새 번호가 그때 다른 지급의 번호이면 그 계정의 지급은 기록되지 않는다(`number_already_used`). 새 번호가 이미 시작 Coin을 받은 번호(지급한 다른 지급의 번호)이면 바꾸고, 회원에게 그 번호로는 이미 시작 Coin을 받아 그 계정은 받지 못한다고 알린다(오너 결정 2026-10-19, 아래 표). 금액을 기다리는 다른 지급이 붙든 번호로는 바꾸지 않는다(다음 항목).
- 새 번호가 이미 다른 계정의 지급의 번호이면 이 계정의 지급에 기록하지 않는다 — 번호마다 붙든 행은 하나다. 그 지급을 지급했으면(그 번호로 시작 Coin을 받은 계정이 탈퇴했거나, 운영자가 그 계정의 번호를 바꿨다) 이미 받은 번호라 빠진 것이 없다. 그 지급이 아직 금액을 기다리면(운영자가 그 계정의 번호를 바꿨다) 이 계정에 지급 기록이 있든 없든 **번호를 바꾸지 않는다**(오너 결정 2026-10-19와 그 3차). 그 번호는 그 지급이 기다리는 동안만 받은 번호라, 그 계정이 기다리다 탈퇴하면 풀린다(답 2). 지급 기록이 있는 계정을 그 번호로 바꾸면 이 계정이 받은 뒤 탈퇴했을 때 그 번호로 본인확인한 다음 계정이 또 받는다. 그런 번호는 1단계의 사전 확인이 확인 문자를 보내기 전에 거르고, 그 뒤에 그렇게 되었으면 5단계의 SQL이 지급 기록이 있든 없든 오류로 거절한다 — 지급 기록이 있으면 `INSERT`가, 없으면 그 뒤의 `DO`가. 회원에게는 까닭 없이 '지금은 그 번호로 바꿀 수 없습니다'라고만 알리고, 회원이 나중에 다시 요청하면 그 요청을 1단계부터 처리한다(아래 표). 기다리다 탈퇴로 이미 취소된 지급의 번호는 풀려 있어 바꾼다(지급 기록이 있으면 기록된다, 답 2).
- 그 계정의 좋아요(`post_likes`·`comment_likes`, #49)가 새 번호의 해시로 옮겨진다(오너 결정 2026-10-20·21, ADR-0076). 좋아요는 본인확인한 번호마다 한 번이라(ADR-0069 결정 7) 그 계정의 좋아요가 새 번호의 것이 된다 — 그 계정이 누른 것과, 그 계정이 같은 번호의 탈퇴한 계정에게서 이어받아 자기 것으로 보던 것(옛 번호의 해시를 싣고 행의 계정에 본인확인 기록이 없는 좋아요, ADR-0076 결정 7-3) 모두다. 그래서 뒤에 옛 번호로 본인확인한 다른 계정은 그 글·댓글에 자유롭게 누른다. 옮기는 좋아요의 글·댓글에 새 번호로 이미 누른 좋아요(그 번호를 가졌다가 탈퇴한 계정의 것)가 있으면 하나만 남긴다 — 옮겨 오는 것이고, 다른 행은 지워져 수가 하나 준다. 새 번호로 이미 누른 좋아요가 살아 있는(본인확인 기록이 있는) 다른 계정의 것이면 — 그 계정의 번호가 이 절차 밖에서 바뀌어 좋아요가 예전 번호의 해시에 남았을 때만 생긴다(ADR-0076 결정 7-19) — 그 좋아요가 남고 옮겨 오는 것이 빠진다. 살아 있는 계정의 좋아요는 그 계정의 것이라 다른 계정의 좋아요를 옮기려고 지우지 않는다(ADR-0076 결정 7-26). 그 계정은 그 글·댓글을 누르지 않은 것으로 보고, 수가 하나 준다. 그 계정이 누르지 않은 글·댓글에 새 번호로 남은 탈퇴한 계정의 좋아요는 그대로이고, 그 계정이 자기 것으로 보고 취소할 수 있다(같은 번호로 다시 가입한 계정과 같다, ADR-0076 결정 7-3). 옮긴 좋아요는 누른 계정·글·댓글·누른 때가 그대로다(이어받은 좋아요의 누른 계정도 그 탈퇴한 계정 그대로다) — `buddha_app`에는 좋아요의 UPDATE가 없어(마이그레이션 0035) 행을 지우고 새 번호의 해시로 다시 넣는다. 5단계의 둘째 `DO`가 하고, 결과는 `DO` 한 줄이라 읽을 것이 없다. 이어받은 좋아요는 옛 번호의 해시로 찾으므로 3단계에서 옛 번호의 해시도 센다.
- 그 계정의 신고(`reports`, #50) 가운데 처리를 기다리는 것과 지난 24시간에 낸 것이 새 번호의 해시로 옮겨진다(오너 결정 2026-10-21, ADR-0081). 신고의 '같은 사람'(같은 대상의 처리 전 신고는 하나, 지난 24시간 20건)도 본인확인한 번호로 세므로(ADR-0069 결정 7), 그 두 규칙이 읽는 신고가 새 번호를 따라간다 — 그 계정이 그 뒤 탈퇴하고 새 번호로 다시 가입하면 그 신고를 이어받고, 옛 번호로 본인확인한 다음 사람은 이어받지 않는다. 옮기는 것은 번호의 해시뿐이다 — 무엇을 신고했는지(대상·사유·설명·접수 시각)와 처리(결과·처리 시각·처리한 운영자)는 그대로다. 처리된 지 24시간이 지난 신고는 어느 규칙도 다시 읽지 않아 낸 때의 해시로 남는다. 그 계정이 같은 번호의 탈퇴한 계정에게서 이어받아 자기 것으로 세던 신고(옛 번호의 해시를 싣고 신고한 계정에 본인확인 기록이 없는 신고) 가운데 처리를 기다리는 것과 지난 24시간의 것도 함께 옮긴다 — 좋아요처럼 3단계에서 센 옛 번호의 해시로 찾는다. 살아 있는(본인확인 기록이 있는) 다른 계정의 신고는 옛 번호의 해시에 있든 새 번호의 해시에 있든 옮기지도 지우지도 않는다(좋아요의 규칙과 같다, ADR-0076 결정 7-26). 신고는 번호마다 하나라는 규칙이 없어, 옮겨 오는 신고가 새 번호의 해시에 이미 있는 신고(그 번호를 가졌다가 탈퇴한 계정의 것이나, 번호가 이 절차 밖에서 바뀐 계정의 것)와 부딪히지 않으므로 지우거나 빼는 것도 없다. 신고의 기록 트리거(`reports_keep_record`)는 이 트랜잭션이 `SET LOCAL`로 넘긴 계정의 신고와 옛 번호의 해시를 실은 탈퇴한 계정의 신고를 그 새 번호의 해시로 바꾸는 것만 받는다 — 앱은 그 값을 넘기지 않으므로 앱의 어떤 쓰기도 신고의 해시를 바꾸지 못한다. 5단계의 셋째 `DO`가 하고, 결과는 `DO` 한 줄이라 읽을 것이 없다.
- 그 계정의 작성 빈도 제한(#187)이 센 쓰기(`write_limit_events`)와 반복 링크 탐지가 센 링크 사용(`link_uses`) 가운데 지난 24시간의 것이 새 번호의 해시로 옮겨진다(오너 결정 2026-10-22, ADR-0083). 둘 다 본인확인한 번호의 해시로 세는 기록이라(ADR-0069 결정 7) 그 계정의 쓰기는 바꾼 뒤에도 하던 셈을 이어 가고, 뒤에 옛 번호로 본인확인한 다른 계정은 처음부터 센다. 무엇이 그 계정의 것인지는 좋아요·신고의 규칙과 같다(ADR-0076 결정 7-26). 링크 사용은 그 링크를 받은 글·댓글의 작성자의 것이라(작성자의 쓰기와 수정이 남긴다) 그 계정이 쓴 글·댓글의 사용과, 옛 번호의 해시를 싣고 작성자에게 본인확인 기록이 없는(탈퇴한) 글·댓글의 사용 — 그 계정이 같은 번호의 탈퇴한 계정에게서 이어받은 것 — 을 옮기고, 살아 있는(본인확인 기록이 있는) 다른 계정의 사용은 옛 번호의 해시에 있든 다른 해시에 있든 옮기지 않는다. 센 쓰기에는 계정이 없어(번호의 해시·종류·시각뿐이다) 옛 번호의 해시로 남은 것을 모두 옮긴다 — 같은 번호의 탈퇴한 계정이 남긴 것도 함께 옮긴다. 살아 있는 다른 계정의 것이 옛 번호의 해시에 남는 것은 그 계정의 번호가 이 절차 밖에서 바뀌었을 때뿐이고(ADR-0076 결정 7-19) 그 계정은 지금 번호로 세므로 어느 한도도 그것을 다시 읽지 않는다 — 옮기면 이 계정의 셈이 엄격해질 뿐 누구의 셈도 느슨해지지 않는다. 두 표에는 번호마다 하나라는 규칙이 없어 옮겨 오는 기록이 새 번호의 해시에 이미 있던 기록(그 번호를 가졌다가 탈퇴한 계정의 것)과 부딪히지 않으므로 지우거나 빼는 것도 없다. 옮긴 기록은 종류·주소·글이나 댓글·시각이 그대로다 — `buddha_app`에는 두 표의 UPDATE가 없어(마이그레이션 0041) 행을 지우고 새 번호의 해시로 다시 넣는다. 24시간보다 오래된 기록은 어느 창에도 들지 않아 옮기지 않고, 24시간에 한 시간이 더 지나면 워커가 지운다(`community.records_purge`). 이어받은 사용과 센 쓰기는 옛 번호의 해시로 찾으므로 3단계에서 옛 번호의 해시도 센다. 5단계의 넷째 `DO`가 하고, 결과는 `DO` 한 줄이라 읽을 것이 없다. 운영자 검토 목록에 이미 오른 항목(`link_flags`)은 번호가 아니라 글·댓글에 붙어 있어 그대로다. 옮긴 링크 사용과 새 번호에 이미 있던 사용(그 번호를 가졌다가 탈퇴한 계정의 것)을 합쳐 같은 링크의 글·댓글이 셋 이상이 되어도 이 단계는 목록에 올리지 않는다 — 그 계정이 그 링크를 다음에 쓸 때 그 항목이 모두 오른다(ADR-0083 결정 7-10).
- 본인확인 발송 기록(`phone_verification_codes`)은 본인확인 기록이라 옛 번호를 그대로 담고 남는다(ADR-0070).

해시는 SQL로 셀 수 없다. 키(`PHONE_HASH_KEY`)가 있어야 하고, 키는 api 컨테이너의 환경에만 있다. 그래서 api 이미지의 해시 CLI(`apps/api/src/identity/phone-hash-cli.ts`)가 그 컨테이너 안에서 API와 같은 키·같은 함수(`phoneHash`)로 센다. CLI는 키를 찍지 않는다. 키를 컨테이너 밖으로 꺼내지 않는다.

**1. 요청 확인.** 아래를 이 순서로 모두 마친 요청만 처리한다(오너 결정 2026-10-19와 그 3차·4차, ADR-0071 7-20·7-29\~7-33).

먼저 요청 메일을 본다. 요청은 그 계정의 가입 이메일, 곧 그 계정의 지금 이메일(`user.email`)에서 보낸 것만 받고, 다른 주소에서 온 요청으로는 바꾸지 않는다. 카카오·네이버가 이메일을 주지 않아 대체 주소(`…@noemail.buddha.local`)인 계정은 그 주소로 메일을 보낼 수 없으므로, 회원이 MY 설정의 '계정'에서 실제 이메일을 먼저 등록하고(인증 메일의 링크를 누르면 그 계정의 이메일이 된다) 그 주소에서 요청해야 한다. 보낸 주소는 위조될 수 있으므로 그 메일이 발신 인증을 통과했는지 본다. 보는 것은 고객센터 메일함의 메일 서비스가 그 메일을 받으며 스스로 매긴 판정 하나다 — 메일 원본의 맨 위 `Authentication-Results` 줄(그 서비스의 받는 서버가 자기 이름, 곧 authserv-id를 맨 앞에 적어 더한 줄)이나, 그 서비스가 원본 보기 같은 곳에 따로 보여 주는 판정이다. 그 아래에 있는 다른 `Authentication-Results` 줄과 `ARC-Authentication-Results` 줄은 보낸 쪽이나 거쳐 온 서버가 써 넣을 수 있으므로 보지 않는다. 고객센터 이메일이 아직 미정이라 그 서비스의 authserv-id를 적지 못했다 — 정해지면 여기에 적는다(ADR-0071 결과 5). 그 판정이 다음 둘 가운데 하나이면 통과다(오너 결정 2026-10-19 4차의 답 2). 하나는 SPF와 DKIM이 모두 `pass`이고 통과한 도메인이 둘 다 보낸 주소(From)의 도메인과 같은 것이다: SPF는 `smtp.mailfrom`의 도메인이고(서비스에 따라 주소 전체로 적으니 `@` 뒤를 본다), DKIM은 서명한 도메인이다(`header.d=도메인`, Gmail은 `header.i=@도메인`). 다른 하나는 DMARC가 `pass`인 것이다(`dmarc=pass`, 그 판정의 `header.from`이 보낸 주소의 도메인). 어느 쪽도 아니면 여기서 그만둔다.

그다음 보낸 주소의 계정을 찾는다. 아무것도 보내기 전에 셸(2단계)에서 psql(4단계)로 붙어 요청을 보낸 주소로 찾는다 — 읽기만 한다. 계정의 이메일은 소문자로 저장되어 있다. 줄이 없으면 그 주소는 어느 계정의 가입 이메일도 아니므로 여기서 그만둔다 — 문자를 보내지 않고 아무것도 바꾸지 않는다. `verified` = `f`이면 그 계정에 바꿀 본인확인 기록이 없으므로(본인확인 전이거나 탈퇴한 계정) 거절한다 — 문자를 보내지 않고 거절의 문장만 알린다. 찾은 `id`는 적어 둔다 — 아래의 사전 확인에 넣고, 회원의 답장이 오면 같은 조회로 다시 찾아 견준다.

```sql
\set sender 'member@example.com'
SELECT u.id, pv.user_id IS NOT NULL AS verified
  FROM "user" u LEFT JOIN phone_verifications pv ON pv.user_id = u.id
  WHERE u.email = lower(:'sender');
```

그 계정(`verified` = `t`)을 찾았으면, 확인 문자를 보내기 전에 새 번호를 5단계가 거절할지 미리 본다(사전 확인, 오너 결정 2026-10-19 4차의 답 1). 3단계의 해시 CLI를 띄워 요청 메일의 새 번호를 넣고, 찍힌 두 줄(`\set new_phone`·`\set new_hash`)을 이 psql에 붙여 넣은 뒤, 찾은 `id`를 넣어 돌린다 — 읽기만 한다. CLI가 휴대전화 번호가 아니라고 하면 요청 메일의 번호를 다시 보고 넣는다. 요청의 번호가 휴대전화 번호가 아니면 거절한다.

```sql
\set user_id '<찾은 계정 id>'
SELECT EXISTS (SELECT 1 FROM phone_verifications pv
      WHERE pv.phone = :'new_phone' AND pv.user_id <> :'user_id') AS other_verified,
    EXISTS (SELECT 1 FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
      WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL
        AND g.user_id <> :'user_id' AND g.granted_at IS NULL) AS other_waiting;
```

`other_verified`는 새 번호가 다른 계정이 본인확인한 번호인지(5단계의 `UPDATE` 오류), `other_waiting`은 새 번호를 금액을 기다리는 다른 계정의 지급이 붙들고 있는지(5단계의 `INSERT`·`DO` 오류)다. 하나라도 `t`이면 거절한다 — 문자를 보내지 않고 거절의 문장만 알린다. 둘 다 `f`일 때만 확인 번호를 뽑는다. 이 계정 자신의 번호, 이 계정의 지급이 붙든 번호, 다른 계정이 이미 시작 Coin을 받은 번호는 거르지 않는다 — 5단계가 바꾼다(아래 결과 표).

확인 번호는 3단계의 CLI를 `--code`로 띄워 뽑은 무작위 6자리 숫자다(앞의 0도 자리다). CLI는 Node의 암호용 난수(`crypto.randomInt`)로 뽑는다 — 이 번호를 아는 것만이 새 번호의 주인이라는 확인이므로 짐작할 수 없어야 하고, PostgreSQL의 `random()`은 암호용 난수가 아니어서 쓰지 않는다(ADR-0071 7-29). 운영자가 머리로 고른 번호도 쓰지 않는다. `--code`는 입력을 받지 않고 키를 쓰지 않으므로 환경도 읽지 않으며, 번호 한 줄을 찍고 끝난다.

```bash
sudo docker compose -f /data/buddha/compose.yaml exec api node apps/api/dist/identity/phone-hash-cli.js --code
```

문자는 알리고 콘솔 같은 곳에서 손으로, 찍힌 `\set new_phone` 줄의 번호로 보낸다 — 회원이 번호를 바꾸는 화면이 없으므로 앱의 본인확인 문자는 쓸 수 없다. 손으로 보낸 문자는 앱의 발송 기록(`phone_verification_codes`)과 발송 한도, `/admin/sms`의 수에 들지 않는다. 문구는 이것으로 정해져 있고(오너 결정 2026-10-19 4차의 답 2) `NNNNNN` 자리에 확인 번호를 넣는다.

```text
[buddha] 번호 변경 확인 번호 NNNNNN
```

그리고 회원에게 메일을 보내, 새 번호로 받은 확인 번호를 30분 안에 이 메일의 답장으로 보내 달라고 알린다. 이 메일의 받는 사람은 위에서 계정을 찾은 주소(`sender`에 넣은 주소, 곧 그 계정의 `user.email`)를 손으로 적거나, 받는 사람이 정확히 그 주소인지 보고 보낸다 — 요청 메일의 답장 버튼으로 받는 사람을 정하지 않는다. 답장 버튼은 요청 메일의 `Reply-To`로 보낼 수 있어서, 위조된 요청이면 진짜 회원은 이 메일을 보지 못한다. 이 요청에서 회원에게 보내는 다른 메일(거절의 문장, 번호를 바꿨다는 회신)도 받는 사람을 같은 주소로 적는다. 확인 번호는 문자로만 보내고 메일에는 적지 않는다 — 그 번호를 아는 것이 새 번호의 문자를 받았다는 확인이다. 답과 맞춰 볼 수 있게 보낸 확인 번호와 그 번호를 보낸 휴대전화 번호(숫자만), 문자를 보낸 시각, 이 요청의 몇 번째 확인 번호인지를 함께 적어 둔다 — 3단계에서는 그 휴대전화 번호만 넣는다. 확인 번호는 문자를 보낸 때부터 30분 동안 유효하고, 새 확인 번호를 보내면 앞의 번호는 더 쓰지 않는다(오너 결정 2026-10-19 4차의 답 2).

회원의 답을 기다리는 동안 psql을 열어 두지 않는다. 답장도 요청 메일처럼 발신 인증을 본다 — 통과하지 못한 답장으로는 아무것도 하지 않는다. 인증을 통과한 답장이 오면 다시 붙어 위의 계정 찾기를 답장을 보낸 주소로 다시 돌린다(같은 SQL, `sender`에 답장의 보낸 주소). 처음에 찾은 것과 같은 `id`에 `verified` = `t`가 아니면 거절한다 — 줄이 없거나, `verified` = `f`이거나, 다른 `id`이면 그 주소가 이제 그 계정의 지금 이메일이 아니거나(회원이 그 사이에 이메일을 바꿨다) 바꿀 본인확인 기록이 없다. 같으면 답장의 번호를 마지막으로 보낸 확인 번호와 견준다. 회원이 가입 이메일(요청을 보낸 그 주소)에서 답장으로 보낸 번호가 마지막으로 보낸 확인 번호와 같고, 고객센터 메일함이 그 답장을 받은 때가 그 번호의 문자를 보낸 때부터 30분 안일 때만 다음 단계로 간다. 5단계의 `user_id`는 이 다시 찾은 `id`다.

번호가 다르거나 30분이 지났으면 바꾸지 않는다. 이 요청에 보낸 확인 번호가 셋보다 적으면 새 확인 번호를 보낼 수 있다 — 3단계의 해시 CLI에 적어 둔 휴대전화 번호를 넣어 사전 확인을 다시 돌리고, 둘 다 `f`이면 새 확인 번호를 뽑아 같은 번호로 보내고 같은 주소로 다시 메일을 보낸다. 한 요청에 확인 번호는 모두 세 번까지다(오너 결정 2026-10-19 4차의 답 2). 셋째 확인 번호에도 맞는 답이 오지 않으면(번호가 다르거나 30분이 지났으면) 그 요청은 거절한다. 답이 오지 않으면 아무것도 바꾸지 않는다. 회원이 그 뒤에 다른 번호로 바꿔 달라고 하면 그 번호는 확인하지 않은 번호이므로 새 요청으로 보고 1단계부터 한다(그 번호로 새 확인 번호를 보낸다).

**2. 셸.** `aws ssm start-session --profile inno-frame --target "$(terraform output -raw instance_id)"`([terraform/README.md](../terraform/README.md#셸)). 아래 명령은 모두 그 세션 안에서 한다.

**3. 새 번호와 옛 번호의 해시.** api 컨테이너에서 CLI를 띄우고 새 번호, 곧 1단계에서 확인 번호를 보내고 적어 둔 그 번호를 입력한 뒤 Enter를 누른다(하이픈·공백이 있어도 된다). 1단계의 사전 확인에서 처음 띄울 때는 요청 메일의 번호를 넣는다. 번호는 명령줄이 아니라 입력으로 받으므로 셸 기록과 프로세스 목록에 남지 않는다.

```bash
sudo docker compose -f /data/buddha/compose.yaml exec api node apps/api/dist/identity/phone-hash-cli.js --psql
```

CLI는 psql에 그대로 붙여 넣을 두 줄을 찍고 끝난다. 두 값이 입력한 하나의 번호에서 나오므로 바꿀 번호와 기록할 해시가 어긋나지 않는다.

```text
\set new_phone '01098765432'
\set new_hash '<소문자 16진 64자>'
```

붙여 넣기 전에 찍힌 `\set new_phone` 줄의 숫자가 1단계에서 적어 둔 번호(확인 번호를 보낸 번호)와 한 자리도 빠짐없이 같은지 본다(1단계의 사전 확인에서 처음 띄울 때는 요청 메일의 번호와 견준다). 다르면 붙여 넣지 않고 CLI를 다시 띄워 그 번호를 다시 입력한다 — 다른 번호를 넣으면 5단계는 표대로 `COMMIT`으로 끝나 알아챌 수 없고, 회원이 확인하지 않은 번호가 그 계정의 번호가 되며, 그 계정에 지급 기록이 있으면 그 번호가 그 지급의 번호로 기록되어 지급한 뒤에는 그 번호의 주인도 시작 Coin을 받지 못한다.

휴대전화 번호가 아니면 까닭을 알리고 다시 입력을 기다린다(그만두려면 Ctrl-D). 운영 API가 뜨지 못하는 환경(`PHONE_HASH_KEY`가 없거나 규칙에 맞지 않음)이면 CLI도 어느 변수가 무슨 규칙에 걸렸는지만 알리고 끝난다. `--psql` 없이 띄우면 한 줄에 번호 하나씩 받아 해시만 한 줄씩 찍는다. `--code`로 띄우면 1단계의 확인 번호 하나만 찍는다.

그다음 옛 번호, 곧 그 계정이 지금 가진 번호의 해시를 센다(오너 결정 2026-10-21, ADR-0076, 2026-10-22, ADR-0083). 5단계는 그 계정이 같은 번호의 탈퇴한 계정에게서 이어받은 좋아요와 신고도 새 번호로 옮기고(위의 '바뀌는 것', 신고는 ADR-0081) 그 계정의 지난 24시간의 쓰기 셈과 링크 사용 기록도 옮기며(ADR-0083), 이어받은 것들과 쓰기 셈은 옛 번호의 해시로 찾는다. 먼저 psql(4단계)에서, 1단계에서 답장의 주소로 다시 찾은 계정의 id로 그 계정의 지금 번호를 읽는다 — 읽기만 한다. 줄이 없으면 그 계정에 본인확인 기록이 없다(그 사이에 탈퇴했다) — 아래 결과 표의 `UPDATE 0`처럼 한다.

```sql
\set user_id '<계정 id>'
SELECT phone FROM phone_verifications WHERE user_id = :'user_id';
```

그리고 CLI를 `--psql-old`로 띄워 읽은 번호를 입력한다. 새 번호처럼 psql에 붙여 넣을 두 줄을 한 번의 입력에서 찍는다.

```bash
sudo docker compose -f /data/buddha/compose.yaml exec api node apps/api/dist/identity/phone-hash-cli.js --psql-old
```

```text
\set old_phone '01012345678'
\set old_hash '<소문자 16진 64자>'
```

찍힌 `\set old_phone` 줄의 숫자가 psql이 읽은 번호와 같은지 본다. 다르게 넣었으면 5단계의 `UPDATE`가 바꾸지 않고(그 계정이 `old_phone`을 가졌을 때만 바꾼다, 아니면 `UPDATE 0`) 첫 `DO`가 트랜잭션을 거절하므로, 다른 번호의 좋아요는 옮겨지지 않는다 — `COMMIT`해도 `ROLLBACK`이 된다(다른 번호의 신고와 쓰기 셈·링크 사용 기록도 같다). 5단계를 다시 할 때마다(`UPDATE 0` 뒤나, 끊긴 세션 뒤에 같은 일을 다시 할 때) 옛 번호는 다시 읽고 다시 센다 — 바꾼 뒤에는 새 번호가 읽힌다.

**4. psql.** `buddha_app`으로 붙는다 — 앱과 같은 권한이라 앱이 지울 수 없는 표(`start_grants`·`start_grant_numbers` 등)는 손으로도 지우지 못한다. `PSQL_HISTORY=/dev/null`은 입력한 번호와 SQL이 psql 기록 파일에 남지 않게 한다.

```bash
sudo docker compose -f /data/buddha/compose.yaml exec -e PSQL_HISTORY=/dev/null postgres \
  psql -U buddha_app -d buddha
```

**5. 바꾸고 기록하기.** 1단계에서 답장의 주소로 다시 찾은 계정의 id와 3단계의 네 줄(`new_phone`이 확인 번호를 보낸 번호와 같은지 본 것과, 그 계정의 지금 번호로 찍은 `old_phone`·`old_hash`)을 psql 변수로 넣는다. `ON_ERROR_ROLLBACK`은 끈다(psql의 기본값이지만 `.psqlrc`가 켰을 수 있다). 켜져 있으면 psql이 오류 난 문장만 되돌리고 트랜잭션을 이어 가서, 아래의 거절(오류) 뒤의 `COMMIT`이 기록 없이 번호만 바꾸거나 `UPDATE 0` 뒤에 다른 번호의 좋아요나 기록을 옮긴다. 꺼져 있으면 오류가 트랜잭션 전체를 깨서 `COMMIT`도 `ROLLBACK`이 된다.

```sql
\set user_id '<계정 id>'
\set new_phone '01098765432'
\set new_hash '<3단계가 찍은 값>'
\set old_phone '01012345678'
\set old_hash '<3단계가 옛 번호로 찍은 값>'
\set ON_ERROR_ROLLBACK off
```

그다음 한 트랜잭션으로 돌린다. 마지막 줄의 결과를 읽기 전에는 `COMMIT`하지 않는다.

```sql
BEGIN;
UPDATE phone_verifications SET phone = :'new_phone', updated_at = now()
  WHERE user_id = :'user_id' AND phone = :'old_phone';
INSERT INTO start_grant_numbers (phone_hash, grant_id, source)
  SELECT :'new_hash', g.id, 'operator' FROM start_grants g
  WHERE g.user_id = :'user_id' AND g.cancelled_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM start_grant_numbers n JOIN start_grants h ON h.id = n.grant_id
      WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL
        AND (h.id = g.id OR h.granted_at IS NOT NULL));
SET LOCAL phone_change.user_id = :'user_id';
SET LOCAL phone_change.new_hash = :'new_hash';
SET LOCAL phone_change.old_hash = :'old_hash';
DO $$BEGIN
  IF NOT EXISTS (SELECT 1 FROM phone_verifications
      WHERE user_id = current_setting('phone_change.user_id')
        AND updated_at = now()::timestamptz(3)) THEN
    RAISE EXCEPTION 'refused: the account does not hold old_phone';
  END IF;
  IF EXISTS (SELECT 1 FROM phone_verifications pv
      JOIN start_grant_numbers n ON n.phone_hash = current_setting('phone_change.new_hash')
        AND n.released_at IS NULL
      JOIN start_grants h ON h.id = n.grant_id
      WHERE pv.user_id = current_setting('phone_change.user_id')
        AND h.user_id <> pv.user_id AND h.granted_at IS NULL) THEN
    RAISE EXCEPTION 'refused: a waiting start grant of another account holds the new number';
  END IF;
END$$;
DO $$BEGIN
  DELETE FROM post_likes o USING post_likes a
    WHERE o.post_id = a.post_id AND o.phone_hash = current_setting('phone_change.new_hash')
      AND a.phone_hash <> o.phone_hash
      AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = o.user_id)
      AND (a.user_id = current_setting('phone_change.user_id')
        OR (a.phone_hash = current_setting('phone_change.old_hash')
          AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = a.user_id)));
  DELETE FROM comment_likes o USING comment_likes a
    WHERE o.comment_id = a.comment_id AND o.phone_hash = current_setting('phone_change.new_hash')
      AND a.phone_hash <> o.phone_hash
      AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = o.user_id)
      AND (a.user_id = current_setting('phone_change.user_id')
        OR (a.phone_hash = current_setting('phone_change.old_hash')
          AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = a.user_id)));
  WITH moved AS (DELETE FROM post_likes
      WHERE user_id = current_setting('phone_change.user_id')
        AND phone_hash <> current_setting('phone_change.new_hash')
      RETURNING post_id, user_id, created_at)
    INSERT INTO post_likes (post_id, user_id, phone_hash, created_at)
      SELECT post_id, user_id, current_setting('phone_change.new_hash'), created_at FROM moved
      ON CONFLICT DO NOTHING;
  WITH moved AS (DELETE FROM comment_likes
      WHERE user_id = current_setting('phone_change.user_id')
        AND phone_hash <> current_setting('phone_change.new_hash')
      RETURNING comment_id, user_id, created_at)
    INSERT INTO comment_likes (comment_id, user_id, phone_hash, created_at)
      SELECT comment_id, user_id, current_setting('phone_change.new_hash'), created_at FROM moved
      ON CONFLICT DO NOTHING;
  WITH moved AS (DELETE FROM post_likes l
      WHERE l.phone_hash = current_setting('phone_change.old_hash')
        AND l.phone_hash <> current_setting('phone_change.new_hash')
        AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = l.user_id)
      RETURNING post_id, user_id, created_at)
    INSERT INTO post_likes (post_id, user_id, phone_hash, created_at)
      SELECT post_id, user_id, current_setting('phone_change.new_hash'), created_at FROM moved
      ON CONFLICT DO NOTHING;
  WITH moved AS (DELETE FROM comment_likes l
      WHERE l.phone_hash = current_setting('phone_change.old_hash')
        AND l.phone_hash <> current_setting('phone_change.new_hash')
        AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = l.user_id)
      RETURNING comment_id, user_id, created_at)
    INSERT INTO comment_likes (comment_id, user_id, phone_hash, created_at)
      SELECT comment_id, user_id, current_setting('phone_change.new_hash'), created_at FROM moved
      ON CONFLICT DO NOTHING;
END$$;
DO $$BEGIN
  PERFORM 1 FROM reports r
    WHERE r.reporter_phone_hash <> current_setting('phone_change.new_hash')
      AND (r.status = 'pending' OR r.created_at > now() - interval '24 hours')
      AND (r.reporter_id = current_setting('phone_change.user_id')
        OR (r.reporter_phone_hash = current_setting('phone_change.old_hash')
          AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = r.reporter_id)))
    ORDER BY r.id FOR UPDATE;
  UPDATE reports r SET reporter_phone_hash = current_setting('phone_change.new_hash')
    WHERE r.reporter_phone_hash <> current_setting('phone_change.new_hash')
      AND (r.status = 'pending' OR r.created_at > now() - interval '24 hours')
      AND (r.reporter_id = current_setting('phone_change.user_id')
        OR (r.reporter_phone_hash = current_setting('phone_change.old_hash')
          AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = r.reporter_id)));
END$$;
DO $$BEGIN
  WITH moved AS (DELETE FROM write_limit_events
      WHERE phone_hash = current_setting('phone_change.old_hash')
        AND phone_hash <> current_setting('phone_change.new_hash')
        AND created_at > now() - interval '24 hours'
      RETURNING action, created_at)
    INSERT INTO write_limit_events (phone_hash, action, created_at)
      SELECT current_setting('phone_change.new_hash'), action, created_at FROM moved;
  WITH moved AS (DELETE FROM link_uses u
      WHERE u.phone_hash <> current_setting('phone_change.new_hash')
        AND u.used_at > now() - interval '24 hours'
        AND EXISTS (SELECT 1 FROM (SELECT author_id FROM posts WHERE id = u.post_id
            UNION ALL SELECT author_id FROM post_comments WHERE id = u.comment_id) w
          WHERE w.author_id = current_setting('phone_change.user_id')
            OR (u.phone_hash = current_setting('phone_change.old_hash')
              AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = w.author_id)))
      RETURNING url, post_id, comment_id, used_at)
    INSERT INTO link_uses (url, phone_hash, post_id, comment_id, used_at)
      SELECT url, current_setting('phone_change.new_hash'), post_id, comment_id, used_at FROM moved;
END$$;
SELECT g.user_id = :'user_id' AS this_account, n.source, g.granted_at IS NOT NULL AS paid,
    EXISTS (SELECT 1 FROM start_grants o
      WHERE o.user_id = :'user_id' AND o.cancelled_at IS NULL) AS has_grant
  FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
  WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL;
```

결과를 읽는 법(같은 SQL이 `packages/db/src/phone-change.ts`에 있고, `phone-change.test.ts`가 이 문서의 SQL이 그것과 같은지와 아래 경우마다 psql처럼 돌려 그렇게 되는지를 시험한다 — 결과마다 아래 표의 한 줄만 맞고, 그 줄의 '다음'이 말하는 `COMMIT`이나 `ROLLBACK`으로 끝낸다). `INSERT`는 새 번호를 이 계정의 지급(취소되지 않은 것)에 더한다. 새 번호를 이미 이 지급이나 지급한 지급이 붙들고 있으면 건너뛰고(`INSERT 0 0`), 금액을 기다리는 다른 지급이 붙들고 있으면 건너뛰지 않는다 — 번호마다 붙든 행은 하나라(`start_grant_numbers_phone_hash_live_idx`) 그 `INSERT`가 오류로 끝나 트랜잭션이 깨진다. 이 계정에 지급 기록이 없으면 `INSERT`에는 더할 행이 없으므로, 그 뒤의 `DO`가 같은 경우를 보고 오류로 끝낸다 — 이 계정에 본인확인 기록이 있고 새 번호를 금액을 기다리는 다른 계정의 지급이 붙들고 있으면. 그 둘이 바꾸지 않는 경우의 거절이다(오너 결정 2026-10-19와 그 3차). `UPDATE`는 그 계정이 옛 번호(`old_phone`)를 가졌을 때만 바꾼다 — 3단계에서 다른 번호를 넣었거나 바꾼 뒤에 같은 줄로 다시 돌렸으면(id를 잘못 넣었을 때도) `UPDATE 0`이다. `UPDATE 0`은 그것을 알릴 뿐 트랜잭션을 멈추지 않아 뒤의 문장도 돈다. 그래서 첫 `DO`가 먼저 이 트랜잭션의 `UPDATE`가 그 계정의 본인확인 행을 바꿨는지(`updated_at = now()::timestamptz(3)` — `now()`는 이 트랜잭션이 시작한 때이고, 그 칸처럼 밀리초까지 본다) 보고, 아니면 거절해(`refused: the account does not hold old_phone`) 트랜잭션을 깬다. 그 뒤의 `COMMIT`도 `ROLLBACK`이 되므로, `UPDATE 0`을 보지 못하고 `COMMIT`해도 `INSERT`도, 다른 번호의 해시로 옮긴 좋아요와 신고의 해시, 쓰기 셈과 링크 사용 기록도 남지 않는다. `DO` 앞의 `SET LOCAL` 세 줄은 계정 id와 새 번호·옛 번호의 해시를 네 `DO`에 넘긴다 — psql은 `$$`로 감싼 `DO` 본문에는 변수를 넣지 않는다. 그 값은 이 트랜잭션에만 있다. 마지막 줄의 칸: `this_account`는 새 번호를 붙든 지급이 이 계정의 것인지, `paid`는 그 지급을 지급했는지(`f`면 금액을 기다린다), `has_grant`는 이 계정에 취소되지 않은 지급 기록이 있는지다. 둘째 `DO`는 그 계정의 좋아요를, 셋째 `DO`는 그 계정의 처리 전 신고와 지난 24시간의 신고를(이어받은 것도), 넷째 `DO`는 그 계정의 지난 24시간의 쓰기 셈(옛 번호의 해시에 있는 것 모두)과 링크 사용 기록(그 계정의 글·댓글의 것과 이어받은 것 — 살아 있는 다른 계정의 것은 옛 번호의 해시에 있어도 그대로)을 새 번호의 해시로 옮기고(위의 '바뀌는 것') 저마다 `DO` 한 줄만 찍는다 — 표의 줄을 가르지 않으니 표는 그 줄을 빼고 읽는다. 첫 줄이 `UPDATE 0`이면 그 뒤에 무엇이 찍히든(위의 거절이나 `INSERT`의 오류도) 표의 `UPDATE 0` 줄이다. 그 밖에는, 한 문장이 오류로 끝나면 그 뒤의 문장도 `current transaction is aborted`(25P02)로 돌지 않으므로, 표에서는 첫 오류의 줄을 찾는다. 표의 `DO`에서 오류는 첫 `DO`(거절)의 것이다. `ROLLBACK`으로 끝나는 줄은 모두 거절이고 회원에게는 거절의 문장만 알린다 — `UPDATE 0`에서 id나 옛 번호를 잘못 넣은 것이 드러나 5단계를 다시 할 때만 빼고(오너 결정 2026-10-19 4차의 답 1).

| 결과                                                                                          | 뜻                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 다음                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPDATE 0`                                                                                    | 그 id의 본인확인 기록이 없거나(id가 틀렸거나 본인확인 전·탈퇴한 계정), 그 계정의 지금 번호가 넣은 옛 번호(`old_phone`)가 아니다(3단계에서 다른 번호를 넣었거나, 바꾼 뒤에 같은 줄로 다시 돌렸다). 뒤의 문장도 돌지만 첫 `DO`가 거절해(P0001 `refused: the account does not hold old_phone` — 그 앞의 `INSERT`가 오류로 끝났으면 그 오류) 트랜잭션이 깨졌고, 아무것도 바뀌지 않았다.                                                                                                                                                                                                                                                                | `ROLLBACK;`(`COMMIT`해도 `ROLLBACK`이 된다). 1단계의 계정 찾기를 답장의 주소로 다시 돌린다: `verified` = `t`인 `id`가 넣은 id와 다르면 id를 잘못 넣은 것이니 그 `id`로 5단계를 다시 하고, 같으면 3단계의 옛 번호를 다시 읽고 세어 그 두 줄로 5단계를 다시 하며(바꾼 뒤라면 새 번호가 읽혀 표의 `COMMIT` 줄로 끝난다), 줄이 없거나 `verified` = `f`이면(그 사이에 이메일을 바꿨거나 탈퇴했다) 거절한다 — 회원에게는 까닭 없이 '지금은 그 번호로 바꿀 수 없습니다'라고만 알린다(오너 결정 2026-10-19 4차의 답 1). |
| `UPDATE`에서 오류(23505 `phone_verifications_phone_unique`)                                   | 새 번호는 다른 계정이 본인확인한 번호다 — 1단계의 사전 확인이 거르므로, 그 뒤에 그 계정이 본인확인했다. 트랜잭션이 깨졌다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `ROLLBACK;`. 회원이 확인 문자로 확인한 번호여도 바꾸지 못한다. 회원에게는 까닭 없이 '지금은 그 번호로 바꿀 수 없습니다'라고만 알린다(오너 결정 2026-10-19 4차의 답 1). 회원이 나중에 다시 요청하면 1단계부터 처리한다.                                                                                                                                                                                                                                                                                          |
| `INSERT`에서 오류(23505 `start_grant_numbers_phone_hash_live_idx`)                            | 새 번호는 금액을 기다리는 다른 계정의 지급이 붙들고 있다(운영자가 그 계정의 번호를 바꿨다 — 1단계의 사전 확인이 거르므로, 그 뒤에 그렇게 되었다). 그 지급이 기다리는 동안만 받은 번호라, 그 계정이 기다리다 탈퇴하면 지급이 취소되어 번호가 풀린다(답 2). 바꾸면 이 계정이 시작 Coin을 받은 뒤 탈퇴했을 때 이 번호로 본인확인한 다음 계정이 또 받으므로 **바꾸지 않는다**(오너 결정 2026-10-19). SQL이 거절해 트랜잭션이 깨졌고 아무것도 바뀌지 않았다.                                                                                                                                                                                            | `ROLLBACK;`(`COMMIT`해도 `ROLLBACK`이 된다). 회원에게는 까닭 없이 '지금은 그 번호로 바꿀 수 없습니다'라고만 알린다(오너 결정 2026-10-19 3차·4차). 운영자가 먼저 다시 하지 않는다 — 회원이 나중에 다시 요청하면 1단계부터 처리한다(아래 '거절한 뒤에 다시 요청받았을 때'). 그 지급이 지급되거나(시작 지급액이 들어가면 1분 안) 취소되기(그 계정이 탈퇴하기) 전에는 같은 SQL을 다시 돌려도 같은 오류로 거절되고 아무것도 바뀌지 않는다.                                                                           |
| `DO`에서 오류(P0001 `refused: a waiting start grant of another account holds the new number`) | 이 계정에 지급 기록이 없고(온보딩 전이거나 이미 받은 번호로 본인확인한 계정), 새 번호는 금액을 기다리는 다른 계정의 지급이 붙들고 있다(운영자가 그 계정의 번호를 바꿨다 — 1단계의 사전 확인이 거르므로, 그 뒤에 그렇게 되었다). 그 번호로는 아직 아무도 시작 Coin을 받지 않았다 — 그 지급이 지급되면 받은 번호가 되고, 그 계정이 기다리다 탈퇴하면 풀린다(답 2). 지급 기록이 없는 계정도 그런 번호로는 **바꾸지 않는다**(오너 결정 2026-10-19 3차). 더할 지급이 없어 `INSERT`는 지나갔고 `DO`가 거절해 트랜잭션이 깨졌다. 아무것도 바뀌지 않았다. `DO`는 커밋된 것만 본다 — 그 지급의 지급이나 취소가 아직 끝나지 않았으면 기다리지 않고 거절한다. | `ROLLBACK;`(`COMMIT`해도 `ROLLBACK`이 된다). 위의 `INSERT` 오류와 같다: 회원에게 '지금은 그 번호로 바꿀 수 없습니다'라고만 알리고, 회원이 나중에 다시 요청하면 1단계부터 처리한다(아래 '거절한 뒤에 다시 요청받았을 때').                                                                                                                                                                                                                                                                                       |
| `UPDATE 1`, `INSERT 0 1`, 한 줄 `this_account` = `t`                                          | 번호를 바꾸고 새 번호를 이 계정의 지급의 번호로 기록했다(`source` `operator`). `paid` = `f`이면 그 지급은 금액을 기다리고, 이 계정이 기다리는 동안 탈퇴하면 옛 번호와 함께 이 번호도 풀린다(답 2).                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `COMMIT;`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `UPDATE 1`, `INSERT 0 0`, 한 줄 `this_account` = `t`                                          | 새 번호가 이미 이 계정의 지급의 번호다(같은 일을 다시 했거나, 그 지급에 이미 기록된 예전 번호로 되돌렸다).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `COMMIT;`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `UPDATE 1`, `INSERT 0 0`, 한 줄 `this_account` = `f`, `paid` = `t`, `has_grant` = `t`         | 새 번호는 다른 계정이 시작 Coin을 받은 번호다(그 계정이 탈퇴했거나, 운영자가 그 계정의 번호를 바꿨다). 이미 받은 번호라 빠진 것이 없다. 이 계정의 지급은 그대로다. 그 다른 지급이 아직 기다리면 이 줄이 아니라 위의 `INSERT` 오류다.                                                                                                                                                                                                                                                                                                                                                                                                               | `COMMIT;`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `UPDATE 1`, `INSERT 0 0`, 한 줄 `this_account` = `f`, `paid` = `t`, `has_grant` = `f`         | 이 계정에 지급 기록이 없고(온보딩 전이거나 이미 받은 번호로 본인확인한 계정), 새 번호는 다른 계정이 시작 Coin을 받은 번호다(그 계정이 탈퇴했거나, 운영자가 그 계정의 번호를 바꿨다). 그 행이 붙들고 있는 동안 이 계정은 이 번호로 시작 Coin을 받지 못한다 — 나중의 지급(#58)이 `number_already_used`로 끝나고 아무것도 기록하지 않는다. 옛 번호로는 받았을 수 있다. 그 다른 지급이 아직 기다리면 이 줄이 아니라 위의 `DO` 오류다.                                                                                                                                                                                                                  | `COMMIT;`. 회원에게 번호를 바꿨다고 알릴 때, 이 번호로는 이미 시작 Coin을 받아 이 계정은 시작 Coin을 받지 못한다고 함께 알린다(오너 결정 2026-10-19).                                                                                                                                                                                                                                                                                                                                                           |
| `UPDATE 1`, `INSERT 0 0`, 줄 없음                                                             | 이 계정에 지급 기록이 없다(온보딩 전이거나 이미 받은 번호로 본인확인한 계정). 그 계정의 지급이 기록될 때(#58) 새 번호로 기록된다 — 이미 받은 번호로 본인확인한 계정은 지급 기능이 다시 불릴 때만이다(ADR-0071 결과 4).                                                                                                                                                                                                                                                                                                                                                                                                                             | `COMMIT;`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`COMMIT`한 뒤 그 계정의 번호 기록을 본다. 지급의 원래 번호(`grant`)와 이번에 기록한 번호(`operator`)가 보인다. `released_at`이 찬 행은 그 지급이 기다리다 취소되어 풀린 번호다(답 2).

```sql
SELECT n.source, n.created_at, n.released_at
  FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
  WHERE g.user_id = :'user_id' ORDER BY n.created_at;
```

**거절한 뒤에 다시 요청받았을 때.** 거절한 뒤에는 운영자가 먼저 다시 하지 않고, 회원이 나중에 다시 요청할 때 다시 한다(오너 결정 2026-10-19 3차). 다시 온 요청은 새 요청과 같이 1단계부터 처리한다: 요청 메일의 발신 인증을 보고, 보낸 주소의 계정을 다시 찾고, 사전 확인을 돌리고, 새 확인 번호를 보내 회원의 답을 받는다. 거절 전에 받은 확인으로 다시 하지 않는다 — 다시 요청하기까지는 기한이 없어(기다리는 지급의 거절이면 시작 지급액이 들어가거나 그 계정이 탈퇴할 때까지) 그 사이에 번호의 주인이 바뀌었을 수 있다(ADR-0071 7-28). 그 번호를 붙든 다른 계정의 지급이 아직 기다리면 사전 확인의 `other_waiting`이 `t`이므로 문자를 보내지 않고 다시 '지금은 그 번호로 바꿀 수 없습니다'라고만 알린다. 그 지급이 지급됐거나 취소되어 번호가 풀렸으면 `f`이고, 1단계를 이어 간다.

**하지 않는 것.**

- `start_grants`·`start_grant_numbers`의 행을 지우거나 고치지 않는다. `UPDATE start_grants`는 손으로 돌리지 않는다. 지운 번호는 다시 시작 Coin을 받는다. `buddha_app`은 지울 수 없고, 트리거는 '기다림 → 지급'(그 지급 자신의 `START_GRANT` 원장 행으로만)과 '기다림 → 취소' 밖의 변경을 모두 거절한다. 그러나 기다리는 지급의 취소는 어느 UPDATE에서 와도 받는다: `cancelled_at`을 채우면 그 지급의 번호가 모두(운영자가 기록한 것도) 풀려 다음 계정이 다시 시작 Coin을 받고, 그 계정은 탈퇴하지 않았어도 다시는 지급 기록을 만들지 못한다(계정마다 하나, 취소된 행은 바뀌지 않는다). 취소는 탈퇴(#140, `cancelStartGrant`)만 한다. 슈퍼유저(`postgres`)로 붙으면 지울 수도 있으니 그 롤로 이 절차를 하지 않는다.
- 5단계의 문장을 나눠 돌리지 않는다. `UPDATE`만 돌리면 새 번호가 받은 번호로 기록되지 않고, `INSERT`나 `DO`가 거절할 변경(기다리는 다른 지급의 번호)도 그대로 들어간다. 네 `DO`는 앞의 `SET LOCAL` 세 줄이 넘긴 값으로 보므로 그 줄들과 떼어 돌리지 않는다. 좋아요를 옮기는 둘째 `DO`를 빼면 그 계정의 좋아요가 옛 번호의 해시로 남아, 뒤에 옛 번호로 본인확인한 계정이 그 글·댓글에 누르지 못한다. 신고를 옮기는 셋째 `DO`를 빼면 그 계정이 탈퇴한 뒤 새 번호로 다시 가입한 계정이 그 계정의 처리 전 신고와 24시간의 수를 잇지 않고, 옛 번호로 본인확인한 다음 사람이 잇는다. 신고의 해시는 손으로 고치지 않는다 — 기록 트리거가 이 트랜잭션 밖의 변경을 거절한다. 기록을 옮기는 넷째 `DO`를 빼면 그 계정의 지난 24시간의 쓰기 셈과 링크 사용이 옛 번호에 남아, 그 계정은 새 번호로 처음부터 세고 뒤에 옛 번호로 본인확인한 계정이 그 셈을 이어받는다. 옛 번호의 두 줄은 짐작하거나 앞서 찍은 것을 다시 쓰지 않는다 — 5단계를 할 때마다 그 계정의 지금 번호를 읽어 CLI로 센다(3단계). 그 계정의 번호가 아닌 번호의 해시는 다른 사람의 좋아요와 신고, 쓰기 셈과 링크 사용 기록을 그 계정에 옮기고 새 번호에 있던 다른 좋아요를 지우게 되므로, `UPDATE`가 `old_phone`으로 보고(아니면 `UPDATE 0`) 첫 `DO`가 그 트랜잭션을 거절한다 — `UPDATE 0`은 알림일 뿐이고, 막는 것은 그 거절이다(`COMMIT`해도 `ROLLBACK`이 된다). 차례도 바꾸지 않는다 — 번호를 바꾸는 `UPDATE`가 그 계정의 본인확인 행을 쥔 뒤에 옮겨야, 그 계정이 그사이에 누른 좋아요와 낸 신고, 센 쓰기도 옮겨지고(좋아요와 신고, 센 쓰기는 그 행을 쥐고 쓴다) 커밋 뒤의 것은 새 번호로 쓰인다. 거절된 변경은 회원이 다시 요청할 때 1단계부터 다시 한다 — 거절 전에 받은 확인으로 5단계만 다시 하지 않는다.
- 해시를 다른 곳에서 세지 않는다. 다른 키로 센 해시는 어느 번호와도 맞지 않아 기록해도 아무것도 막지 못한다.
- 번호의 기록은 번호를 바꾼 계정의 지급에만 더한다. 탈퇴로 취소된 지급(금액을 기다리다 탈퇴한 계정, ADR-0071)에는 더할 수 없다 — 트리거가 거절한다.

**로컬.** 같은 일을 개발 스택에서 해 보려면, `.env`의 `PHONE_HASH_KEY`(비워 두면 개발용 키)로 해시를 세고 개발 DB에 붙는다.

```bash
corepack pnpm --filter api build
corepack pnpm --filter api run phone-hash --psql
corepack pnpm --filter api run phone-hash --psql-old
docker compose exec -e PSQL_HISTORY=/dev/null postgres psql -U buddha_app -d buddha
```

## API 컨테이너의 메모리 확인 (#46, ADR-0073 9-46)

API는 이미지 업로드의 본문·변환·이미지 읽기를 받기 전에 자기 상주 메모리(RSS)를 본다(오너 결정 2026-10-22 답 3). 그 RSS와 이미 내준 몫에 제 몫(본문의 길이, 변환 하나의 144MiB, 이미지의 바이트)을 더해 한도를 넘으면 기다리고(업로드 10초, 변환은 대기열에 든 때부터 10초, 읽기 2초), 그래도 자리가 나지 않으면 429로 돌려보낸다. 업로드 본문과 변환은 이미지 읽기가 아직 가져갈 수 있는 몫(읽기의 예산 32MiB 가운데 빈 것)도 남겨 두고, 이미지 읽기는 그 대신 도는 변환의 몫을 세지 않는다 — 변환이 이미지 읽기를 붙잡지 않는다. 한도는 컨테이너의 메모리 한도(`deploy/compose.yaml`의 api `memory: 448m`)에서 32MiB를 뺀 416MiB다(`API_MEMORY_CEILING_MIB`로 바꾼다, docs/SETTINGS.md). 그래서 **대기 중의 API에 변환 하나(144MiB)와 읽기의 몫(32MiB)을 더해 416MiB 안이어야** 업로드가 변환된다(대기 중의 값이 240MiB 아래). 이 PR은 그 값을 운영과 같은 이미지·한도(linux arm64, 448MiB) 안에서 약 150MiB로 쟀다 — 운영의 실제 값은 오너가 확인한다(ADR-0073 결과 3).

1. 배포 뒤 요청이 없는 때에 호스트 셸에서 api 컨테이너의 메모리를 본다. `MEM USAGE`가 대기 중의 값이다(그 컨테이너가 쥔 메모리 — 페이지 캐시 가운데 비활성인 것은 빠진다).

   ```bash
   sudo docker stats --no-stream buddha-api-1   # compose 프로젝트 buddha의 api 서비스
   ```

2. API의 시작 로그에서 한도와 그때의 RSS를 본다(맥락이 `MemoryAdmission`인 `image work memory: ceiling set` 줄 — 줄의 메시지는 문장 뒤에 값들의 JSON이 붙은 것이다: `ceilingMiB`·`limitMiB`·`residentMiB`).

   ```bash
   sudo docker compose -f /data/buddha/compose.yaml logs api | grep 'image work'
   ```

3. 메모리가 모자라 기다리다 돌려보낸 요청이 있으면 `image work refused: no room under the memory ceiling in time` 줄이 남는다(값들은 그 문장 뒤의 JSON에 있다) — 첫 거절은 곧바로, 그 뒤로는 1분에 한 줄까지이고, 그 1분 안의 거절은 1분이 끝날 때 한 줄로 남는다(API가 멈출 때 남은 것도). 줄마다 `refused`는 앞 줄 뒤의 수, `kind`(`body` 업로드 본문·`conversion` 변환·`read` 이미지 읽기)·`residentMiB`·`heldMiB`·`neededMiB`·`ceilingMiB`는 그 가운데 마지막 거절의 것이다. 메모리를 기다리는 업로드가 받는 본문의 예산(64MiB)을 채운 동안 기다리지 않고 거절된 업로드(`Too many uploads are being received`의 429)는 이 줄에 세지 않는다. 요청이 몰리지 않았는데도 이 줄이 이어지면(대기 중의 값에 144와 32를 더한 것이 416에 가깝거나 넘는다) 한도(`API_MEMORY_CEILING_MIB`)나 컨테이너의 메모리를 다시 정한다.

## 제재 이의 처리 (#45 14항)

회원은 운영자의 조치에 고객센터 이메일로만 이의를 낸다. 앱에는 이의를 받거나 기록하는 화면이 없다(ADR-0069 결정 2 #45 14항, 결정 4의 #186 행). 회원이 보는 안내는 조치·신고 내역(`/my/moderation`)의 '받은 조치' 맨 위에 한 번 있고 — 고객센터 이메일로 받는다, 어느 조치인지(조치의 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄)를 적어 가입한 이메일로 보낸다, 조치마다 한 번·조치한 때부터 14일 안, 검토하는 동안 조치는 그대로, 결과는 이메일 — 취소되지 않은 조치의 카드마다 그 조치의 '이의 기한'(분까지 보이고, 그 분이 끝나면 '이의 기한이 지났습니다.'와 그 기한)이 있다. 카카오·네이버의 대체 주소 계정에게만 그 안내 아래에 '이의를 보내려면 MY 설정에서 이메일을 먼저 등록해 주세요.'와 MY 설정으로 가는 링크가 있다(오너 결정 2026-10-22 (2차) 3). MY 요약의 경고 띠, MY 요약·글쓰기 화면·MY 설정의 작성 제한 띠(제목·끝나는 때·링크), 작성 제한 중의 거절(막힌 것과 끝나는 때·링크)과 MY '내 글'의 숨김 줄은 조치·신고 내역으로 잇기만 한다(ADR-0084, 오너 결정 2026-10-22·2026-10-23 답 6; ADR-0082). 이메일 주소는 사업자 정보(`apps/web/src/legal/business-info.ts`의 `email`)이고 오너가 정할 때까지 회원에게 '미정'으로 보인다. 받기·검토·회신은 모두 앱 밖에서 한다. 보낸 사람의 계정과 그 회원이 받은 조치는 psql에서 읽기만 하고(2), 결과를 반영할 때만 관리자 화면(`/admin/moderation/…`)을 쓴다.

1. **대상.** 운영자의 모든 조치다 — 숨김·경고·닉네임 강제 변경·소개 비우기·프로필 이미지 삭제·작성 제한(#185)과, 생기면 계정 제한(#139). 계정 제한 중에도 받는다(#57 14항). 취소된 조치에는 이의할 것이 없다(회원의 카드에도 이의 기한이 없다). 작성 제한은 기간이 지났거나 조기 해제·감경했어도 취소한 것이 아니라 그대로 조치다 — 조기 해제와 감경은 끝나는 때만 앞당기므로 이의 기한(조치한 때부터)은 그대로이고 회원의 카드에도 남는다(ADR-0082 7-3). 그래서 끝난 작성 제한에도 기한 안이면 이의를 받는다.
2. **보낸 사람.** 이의는 그 조치를 받은 회원 본인만 낸다 — 다른 회원이 받은 조치에는 이의를 낼 수 없다(#186의 수용 기준, N05 §5). 앱이 이의를 받지 않으므로 이것은 이 절차로 지킨다(오너 결정 2026-10-22 답 5, ADR-0084).
   - 받는 메일: 그 계정의 지금 이메일(`user.email`)에서 보냈고 발신 인증을 통과한 메일만 이의로 받는다. 발신 인증은 [휴대전화 번호 바꾸기](#회원의-휴대전화-번호-바꾸기-57-3항)의 1단계와 같은 판정이다 — 고객센터 메일함의 메일 서비스가 그 메일을 받으며 스스로 매긴 판정 하나(메일 원본 맨 위의 `Authentication-Results` 줄이나 그 서비스가 따로 보여 주는 판정)만 보고, 그 아래의 다른 `Authentication-Results`·`ARC-Authentication-Results` 줄은 보지 않는다. SPF와 DKIM이 모두 `pass`이고 그 도메인이 둘 다 보낸 주소(From)의 도메인과 같거나, DMARC가 `pass`(그 판정의 `header.from`이 보낸 주소의 도메인)이면 통과다. 어느 쪽도 아니면 확인되지 않은 메일이다.
   - 계정 찾기: 보낸 주소의 계정과 그 회원이 받은 조치를 psql에서 찾는다 — 읽기만 한다. [휴대전화 번호 바꾸기](#회원의-휴대전화-번호-바꾸기-57-3항)의 2단계(셸)와 4단계(psql)로 붙어, 그 1단계의 계정 찾기처럼 보낸 주소를 `sender`에 넣고 아래를 돌린다. 계정의 이메일이 보낸 주소와 정확히 같은 계정만 나온다(계정의 이메일은 소문자로 저장되어 있어 보낸 주소를 소문자로 견준다). 줄이 없으면 그 주소는 어느 계정의 지금 이메일도 아니므로 확인되지 않은 메일이다. 줄이 있으면 `user_id`가 그 회원이고, 그 회원의 운영자 화면은 `/admin/moderation/users/<user_id>`다 — 결과를 반영할 조치가 거기에 있다. 줄마다 그 회원이 받은 조치 하나다(최신부터, 받은 조치가 없으면 `action_id`가 빈 줄 하나). `type`은 조치의 종류(`hide` 숨김, `warning` 경고, `nickname_reset` 닉네임 강제 변경, `bio_clear` 소개 비우기, `image_remove` 프로필 이미지 삭제, `writing_restriction` 작성 제한), `acted_kst`는 조치한 때(한국 시간, 초까지), `deadline_kst`는 그 조치의 이의가 기한 안인 마지막 초 — 이의 기한(조치한 때 + 14×24시간)이 화면에 보이는 그 분의 끝(…:59, 한국 시간)이다(3). `cancelled`는 취소된 조치인지다 — 조기 해제하거나 감경한 작성 제한은 취소가 아니라 `f`다(1). `/admin/users`의 찾기로는 계정을 정하지 않는다 — 이메일·닉네임의 부분 일치라 다른 계정도 나오고, 한 번에 20개씩 최신 계정부터라 그 회원의 카드가 '더 보기' 뒤에 있을 수 있으며, 찾는 말은 100자까지라 그보다 긴 주소로는 찾지 못한다(ADR-0084 6-8).

     ```sql
     \set sender 'member@example.com'
     SELECT u.id AS user_id, a.id AS action_id, a.type,
         to_char(a.created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') AS acted_kst,
         to_char((a.created_at + interval '336 hours') AT TIME ZONE 'Asia/Seoul',
           'YYYY-MM-DD HH24:MI') || ':59' AS deadline_kst,
         a.cancelled_at IS NOT NULL AS cancelled
       FROM "user" u LEFT JOIN moderation_actions a ON a.user_id = u.id
       WHERE u.email = lower(:'sender')
       ORDER BY a.created_at DESC, a.id DESC;
     ```

   - 카카오·네이버의 대체 주소: 카카오·네이버가 이메일을 주지 않은 계정의 `user.email`은 대체 주소(`…@noemail.buddha.local`)라 그 주소로는 메일을 보낼 수 없다. 그 회원은 MY 설정의 '계정'에서 실제 이메일을 먼저 등록하고(인증 메일의 링크를 누르면 그 계정의 이메일이 된다) 그 주소에서 보내야 한다 — 그 계정의 조치·신고 내역에만 안내 아래에 그렇게 하라는 줄('이의를 보내려면 MY 설정에서 이메일을 먼저 등록해 주세요.')과 MY 설정 링크가 있다(오너 결정 2026-10-22 (2차) 3). 그 전에 다른 주소에서 온 메일은 확인되지 않은 메일이다.
   - 확인되지 않은 메일: 어느 계정의 지금 이메일도 아닌 주소에서 왔거나 발신 인증을 통과하지 못한 메일은 검토하지 않고, 어느 조치의 한 번도 쓰지 않는다 — 남이 먼저 보낸 메일이 회원의 하나뿐인 이의를 쓰지 않게 하고, 그 뒤에 본인이 지금 이메일에서 보낸 이의는 받는다. 회신은 계정이 있는지(그리고 조치가 있는지) 드러내지 않는 아래의 한 문장만이고, 계정이 있든 없든 어느 경우든 같다. 받는 사람은 그 메일의 보낸 주소(From)를 손으로 적은 것이다(답장 버튼의 `Reply-To`가 아니다). 글은 오너가 정한 것이다(오너 결정 2026-10-22 (2차) 1). 이 문장은 가입한 이메일이 아닌 주소에서 보낸 회원에게 무엇을 할지 알린다. 예외는 하나, 아래의 발신 인증에 계속 실패하는 가입한 이메일이다 — 그 글은 그 계정의 주소로만 간다.

     ```text
     이의는 가입한 이메일로 보낸 메일만 받습니다.
     ```

   - 가입한 이메일인데 발신 인증에 계속 실패하는 메일: 그 계정의 지금 이메일(2의 조회에 줄이 있는 주소)에서 왔는데 발신 인증을 통과하지 못한 메일도 확인되지 않은 메일이다. 위조일 수도 있고, 회원 본인의 메일이 그 메일 서비스나 도메인의 설정 탓에(예: DKIM·DMARC 없이 SPF만 있는 도메인, 전달 주소를 거친 메일) 통과하지 못한 것일 수도 있다 — 본인이라면 다시 보내도 같은 판정이다. 처음 온 그런 메일은 위의 한 문장을 받는다. 같은 주소에서 온 메일이 위의 한 문장을 받은 뒤에도 다시 발신 인증을 통과하지 못하면 — 계속 실패하면 — 그 메일에는 위의 한 문장 대신 아래의 글을 보낸다(글과 받는 사람은 오너 결정 2026-10-23 답 3, '계속'을 두 번째부터로 읽은 것은 이 절차의 선택이다 — ADR-0084 6-8). 받는 사람은 2의 조회로 정한 그 계정의 지금 이메일을 손으로 적은 것이다(6의 받는 사람과 같다 — 답장 버튼으로 정하지 않는다). 그 계정의 주소로만 가므로 보낸 사람이 남이어도 그 사람에게는 계정이 있는지 드러나지 않는다. 이 메일도 검토하지 않고 어느 조치의 한 번도 쓰지 않는다. 그 뒤 회원이 MY 설정에서 바꾼 이메일로 다시 보낸 메일은 새 이의로 2의 확인부터 보고, 기한 안인지는 3대로 그 메일이 메일함에 도착한 시각으로 본다. 처음 메일이 기한 안에 왔어도 위의 두 회신을 거치는 동안 기한이 지날 수 있다 — 그런 드문 경우에 그 메일을 되묻기의 3일(3)처럼 처음 메일의 도착 시각으로 볼지는 7대로 판단한다(오너 결정 2026-10-23 (3차)). 같은 주소에서 앞서 온 메일이 위의 한 문장을 받았는지는 메일함에서 그 보낸 주소로 찾는다 — 그 주소의 발신 인증에 관한 것이라서다(받은 이의는 보낸 주소로 찾지 않는다, 3). 글은 오너가 정한 것이다.

     ```text
     이 주소에서 온 메일은 보낸 사람을 확인할 수 없습니다. MY 설정에서 다른 이메일로 바꾼 뒤 그 주소로 보내 주세요.
     ```

3. **기한과 횟수.** 조치마다 한 번, 조치한 때부터 14×24시간 안이다(`APPEAL_WINDOW_DAYS`). 이의가 기한 안인지는 고객센터 메일함이 그 메일을 받은 시각으로 본다(오너 결정 2026-10-22 답 10) — 메일 서비스가 받은 때로 보여 주는 시각이고, 보낸 쪽이 적는 `Date` 머리가 아니다. 메일함의 시각이 한국 시간이 아니면 한국 시간으로 바꿔 견준다.
   - 어느 조치인지: 회원이 적은 종류와 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄로 찾는다(회원의 안내가 그렇게 적으라고 한다, 오너 결정 2026-10-22 답 6·2026-10-23 답 1). 종류와 조치한 때는 2의 조회에서 보고, 제목이나 첫 줄은 그 회원의 운영자 화면에서 그 조치의 카드의 '글'·'댓글' 링크로 가는 화면에서 본다 — 회원의 카드는 글의 제목(없으면 본문의 첫 줄)이나 댓글의 첫 줄을 보이고, 그 뒤 회원이 지운 글·댓글이면 '삭제한 글'·'삭제한 댓글'이라 제목이나 첫 줄이 없다. 회원이 적는 조치한 때는 회원의 카드에 보인 것이라 회원이 MY 설정에서 고른 시간대(고르지 않았으면 그 브라우저의 시간대)의 시각이고, 그 시간대가 한국 시간(Asia/Seoul)이 아니면 시각 뒤에 그 순간의 UTC와의 차이가 '(GMT-4)'처럼 붙는다. 2의 조회와 관리자 화면은 한국 시간이고 회원의 시간대를 보이지 않으므로, 차이가 붙은 시각은 한국 시간으로 바꿔 견준다 — '2026. 10. 21. 오전 2:00 (GMT-4)'는 한국 시간 2026-10-21 15:00이다. 차이가 붙지 않은 시각은 한국 시간으로 본 회원의 것이거나 회원이 차이를 빼고 옮긴 것이다. 한 메일이 조치 여럿을 따로 적었으면 회원이 적은 것을 조치마다 따로 보고, 그 하나하나가 따로 된 이의다 — 조치마다 한 번이라서다(ADR-0084 6-8 — 드문 경우는 7). 맞는 조치는 회원이 그 이의에 적은 것 — 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄 — 에 모두 맞는 조치다(종류와 제목이나 첫 줄이 맞아도 조치한 때가 맞지 않으면 맞지 않는다, ADR-0084 6-8 — 드문 경우는 7). 회원이 적은 것에 맞는 조치가 하나가 아니면 어느 조치인지 정할 수 없는 이의다(아래의 되묻기 — 되물은 뒤 다시 온 이의가 되묻는 글이 적으라고 한 것을 모두 적고도 여러 조치에 맞으면 함께 받는다). 한 메일의 이의 가운데 일부만 정해지면 정해진 이의는 아래대로 받거나 받지 않고, 정할 수 없는 이의만 되묻는다. 화면의 시각은 분까지라, 그 회원의 운영자 화면에서는 같은 종류와 `acted_kst`의 분까지의 시각('조치한 운영자' 줄의 운영자 닉네임 뒤)으로 그 조치의 카드를 찾는다.
   - 되묻기: 어느 조치인지 정할 수 없는 이의는 검토하지 않고 아래의 두 글 가운데 하나로 되묻는다(오너 결정 2026-10-22 (2차) 2, 글은 오너 결정 2026-10-23 답 1과 2026-10-23 (2차) 답 1). 되묻는 것은 그 조치의 한 번을 쓰지 않는다 — 회원은 글이 말하는 때(그 조치의 기한이나 3일) 안에 다시 보내야 하고, 다시 온 메일은 새 이의로 2의 확인부터 본다. 받는 사람은 6의 받는 사람과 같다. 되물을 때 그 메일에 2의 조회의 `user_id`와 '되물음'을 함께 적은 표시(받은 이의의 표시처럼 메일함에서 찾을 수 있는 것)를 단다 — 다시 온 메일이 그 회원에게 되물은 것에 대한 것인지를 보낸 주소가 아니라 `user_id`로 찾게 하는 것이다(아래 '받지 않는 것'의 표시와 같은 까닭, ADR-0084 6-8). 이 표시에는 `action_id`가 없어 받은 이의로 세지 않는다.

     글은 보통 첫째 것이다. 늦은 되묻기 — 되묻는 메일을 보내는 때에 기한까지 3×24시간보다 적게 남았거나 기한이 지난 되묻기 — 에는 끝이 '3일 안에'인 둘째 것이다(오너 결정 2026-10-23 (2차) 답 1). 어느 조치인지 모르므로 그 기한은 되묻기를 받은 메일이 기한 안에 온 그 회원의 조치 — 2의 조회에서 취소되지 않았고, 그 메일이 온 때까지 받았으며(`acted_kst`가 그 메일이 도착한 시각과 같거나 앞), `deadline_kst`가 그 메일이 그 조치에 기한을 보는 시각(첫 메일이면 그 메일이 도착한 시각, 아래)과 같거나 뒤인 조치 — 마다의 기한이고, 그 가운데 하나라도 `deadline_kst`가 되묻는 메일을 보내는 때부터 3×24시간 뒤보다 앞이면 늦은 되묻기다(ADR-0084 6-8 — 드문 경우는 7). 그 메일이 온 뒤에 받은 조치는 그 메일이 말할 수 없었으므로 넣지 않는다. 그런 조치가 없으면 — 그 메일이 모든 조치에 이미 늦었거나, 기한 안에 온 조치마다 3×24시간 이상 남았으면 — 첫째 글이다.

     ```text
     어느 조치인지(조치의 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄)를 적어 그 조치의 이의 기한 안에 다시 보내 주세요.
     ```

     ```text
     어느 조치인지(조치의 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄)를 적어 3일 안에 다시 보내 주세요.
     ```

     다시 온 메일이 기한 안인지는 그 메일이 메일함에 도착한 시각으로 본다. 다만 늦은 되묻기를 보낸 때부터 3×24시간 안에 도착한 메일은 첫 메일 — 그 되묻기를 받은 메일 — 이 메일함에 도착한 시각으로 본다(3일은 오너 결정 2026-10-23 답 2, 3×24시간과 늦은 되묻기는 오너 결정 2026-10-23 (2차) 답 1). 둘째 글의 '3일'이 이것이다 — 운영자가 기한 무렵이나 기한이 지난 뒤에 되물어도 회원이 제때 보낸 이의를 잃지 않게 하는 것이다. 첫째 글로 되물었으면 그 메일이 기한 안에 온 조치마다 3×24시간 이상 남았으므로, 3×24시간 안에 다시 온 메일은 그 메일이 도착한 시각으로도 기한 안이다. 되묻는 메일을 보낸 때는 보낸 메일함에 남은 그 메일의 시각이고, 한국 시간으로 바꿔 `deadline_kst`와 다시 온 메일의 도착 시각에 견준다. 첫 메일의 도착 시각으로 보는 것은 되묻기 하나에 다시 온 이의 하나다 — 그 3×24시간 안에 다시 온 메일 가운데 2의 확인을 마치고 맞는 조치가 정해진 첫 이의(한 메일이 조치 여럿을 따로 적었으면 그 가운데 먼저 적은 것)의 그 조치(그 이의가 여러 조치에 맞으면 그 모두, 아래)뿐이고, 한 번 더 되물은 것(아래)도 같은 첫 메일의 되묻기로 센다. 그 조치도 첫 메일이 온 때까지 받은 것(`acted_kst`가 첫 메일의 도착 시각과 같거나 앞)이어야 한다 — 그 뒤에 받은 조치는 첫 메일이 말할 수 없었으므로 첫 메일의 도착 시각을 받지 않고 그 조치를 말한 메일이 도착한 시각으로 본다(한 번 더 되물은 뒤는 아래, ADR-0084 6-8 — 드문 경우는 7). 2의 확인을 마치지 못한 메일(확인되지 않은 메일)은 그것을 쓰지 않으므로, 회원은 3×24시간 안에 지금 이메일에서 다시 보낼 수 있다. 같은 메일이나 그 뒤의 메일이 말하는 다른 조치는 그 메일이 도착한 시각으로 본다. 늦은 되묻기로 — 첫 메일의 도착 시각이나, 한 번 더 되물었으면 그 메일이 기한을 보는 시각(아래)으로 — 다시 온 메일을 보았으면 첫 메일의 '되물음'의 표시에 '3일 씀'을 더해 다른 운영자도 알게 한다 — `action_id`는 적지 않는다. 처음 되묻기는 늦지 않았고 한 번 더 되묻기만 늦어 한 번 더 되물은 메일이 도착한 시각으로 본 것도 그렇다 — 그 시각도 다시 온 메일의 것이 아니라 늦은 되묻기가 준 것이다. 되묻기 하나에 다시 온 이의가 여럿인 것 — 한 메일이 따로 적은 조치 여럿이나 메일 여럿 — 은 드문 경우라 7대로 판단한다(이 절차의 읽기로는 위대로 이의 하나, 곧 먼저 적은 조치 하나이고 그 이의가 여러 조치에 맞을 때만 그 모두다, ADR-0084 6-8). 되묻는 두 글은 기한을 적지 않는다 — 어느 조치인지 모르니 어느 기한인지도 모르고, 회원은 그 조치의 카드에서 본다.

     되물은 뒤 다시 온 이의가 되묻는 글이 적으라고 한 것 — 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄(회원의 카드에 '삭제한 글'·'삭제한 댓글'뿐이면 그것) — 을 모두 적고도 여러 조치에 맞으면 — 같은 종류의 조치를 같은 분에 여럿 받았고 그 제목이나 첫 줄도 같은 경우(다른 글이어도 제목이 같을 수 있다)처럼 — 맞는 조치 모두를 한 이의로 함께 받아 검토하고, 맞는 조치마다 그 한 번을 쓴다(오너 결정 2026-10-23 (2차) 답 2). 적으라고 한 것 가운데 무엇을 빼고 적어 여러 조치에 맞으면 — '숨김 조치에 이의합니다'처럼 — 함께 받지 않고 하나도 맞지 않는 것처럼 한 번 더 되묻는다 — 함께 받으면 회원이 말하지 않은 조치의 한 번까지 쓰고, 되묻는 것은 어느 조치의 한 번도 쓰지 않는다(ADR-0084 6-8 — 드문 경우는 7). 아래 '받지 않는 것'은 맞는 조치마다 보고, 받는 조치마다 받은 이의의 표시를 단다. 모두 받지 않는 것이고 그 까닭이 같으면 그 까닭의 한 문장만 회신한다. 까닭이 조치마다 다르면 — 하나는 취소되었고 다른 하나는 기한이 지난 것처럼 — 어느 까닭을 회신할지는 드문 경우라 7대로 판단한다(이 절차의 읽기로는 아래 차례의 앞의 것 하나다 — 그 차례는 오너가 한 조치의 까닭 여럿에 정한 것이라, 함께 맞은 다른 조치의 카드와는 다를 수 있다). 서 있는 조치와 함께 맞은 취소된 조치를 맞는 조치로 셀지도 7대로 판단한다(이 절차의 읽기로는 센다). 일부만 받지 않는 것이면 받는 조치만 검토하고, 6의 회신은 그 이의에 하나로 받은 조치마다 결과를 적는다 — 받지 않은 조치의 까닭을 그 회신에 함께 적을지도 7대로 판단한다(이 절차의 읽기로는 적지 않는다). 다시 온 메일에 맞는 조치가 하나도 없으면 — 회원이 차이('(GMT…)')를 빼고 옮긴 시각이 어느 조치와도 맞지 않는 경우처럼 — 한 번 더 되묻는다(같은 답 2). 그 글도 그때 늦은 되묻기인지로 고르고, 그 되묻기 뒤 3×24시간 안에 다시 온 메일도 위대로 본다 — 한 번 더 되물은 메일이 그 조치에 기한을 보는 시각은, 그 메일이 앞의 늦은 되묻기 뒤 3×24시간 안에 왔고 그 조치가 첫 메일이 온 때까지 받은 것이면 첫 메일의 도착 시각이고, 아니면 그 메일이 도착한 시각이다(ADR-0084 6-8 — 드문 경우는 7). 한 번 더 되물은 뒤에도 맞는 조치가 없으면 다시 되묻지 않고 7대로 판단한다.

   - 기한: 회원에게 보인 기한의 그 분이 끝날 때(…:59)까지 메일함에 도착한 메일은 기한 안이다(오너 결정 2026-10-23 답 5). 그 마지막 초가 2의 조회에서 그 조치의 `deadline_kst`(한국 시간)다 — 받은 시각이 `deadline_kst`와 같거나 앞이면 기한 안이고, 뒤면 지났다(늦은 되묻기 뒤 3×24시간 안에 다시 온 메일은 위의 되묻기대로 첫 메일의 도착 시각으로 본다 — 되묻기 하나에 다시 온 이의 하나이고, 첫 메일이 온 때까지 받은 조치에만이다. 2의 발신 인증에 계속 실패한 가입한 이메일의 회원이 바꾼 이메일로 다시 보낸 메일은 그 메일의 도착 시각으로 보고, 두 회신을 거치는 동안 기한이 지났으면 7대로 판단한다). 메일함이 받은 시각을 분까지만 보이면 그 분이 `deadline_kst`의 분과 같거나 앞이면 기한 안이다(초까지 볼 것이 없다). 관리자 화면의 시각('조치한 운영자' 줄의 운영자 닉네임 뒤 시각, '조치 취소' 창 맨 위의 조치 줄 — 종류 · 닉네임 · 시각 — 의 시각)과 회원의 카드('조치한 때'·'이의 기한')는 분까지만 보이고 초를 버리므로, 기한은 화면의 시각에 손으로 14일을 더하지 않고 `deadline_kst`로 본다. 회원의 카드도 그 분이 끝날 때 '이의 기한이 지났습니다.'로 바뀐다.
   - 받지 않는 것: 어느 조치인지 정해진 이의라도 취소된 조치(`cancelled` = `t`)이거나, 기한이 지났거나, 그 조치에 이미 이의를 받았으면 받지 않고, 그 까닭을 아래의 한 문장으로 회신한다(오너 결정 2026-10-22 (2차) 2). 한 조치가 여럿에 해당하면 이 차례에서 앞의 것 하나다 — 그 조치의 카드가 보이는 것(취소된 조치에는 '취소됨'이 있고 이의 기한이 없다, 기한이 지난 조치에는 '이의 기한이 지났습니다.')과 맞춘 차례다(함께 맞은 조치마다 까닭이 다른 것은 위의 되묻기와 7). 세 문장과 이 차례는 오너가 정한 것이다(오너 결정 2026-10-23 답 1). 앱은 이의를 세지 않으므로 그 조치에 이미 이의를 받았는지는 고객센터 메일함에서 본다 — 받은 이의, 곧 2의 확인을 마치고 어느 조치인지 정해졌으며 그 조치가 취소되지 않았고 기한 안이라 4의 검토로 넘긴 이의만 센다. 되물은 뒤 다시 온 이의를 여러 조치에 함께 받았으면 받은 조치마다 센다(위의 되묻기). 확인되지 않은 메일(2), 되물은 메일(위), 여기서 받지 않은 메일은 세지 않는다. 받은 이의는 메일함에 표시해 둔다. 이의를 받아 4의 검토로 넘길 때, 검토를 시작하기 전에 그 메일에 2의 조회의 `user_id`와 `action_id`를 함께 적은 표시(메일 서비스의 라벨이나 메모처럼 메일함에서 찾을 수 있는 것)를 단다 — 여러 조치에 함께 받았으면 조치마다 단다. 새 이의를 받기 전에는 그 메일의 2의 조회로 정한 `user_id`와 `action_id`로 메일함에서 그 표시를 찾는다 — 보낸 주소로 찾지 않는다. 계정의 이메일은 MY 설정에서 바뀌고(ADR-0023) DB에 이전 주소가 남지 않아서, 같은 회원이 다른 주소에서 같은 조치에 다시 보낼 수 있다. 표시가 있으면 6의 회신이 아직 없어도 받은 이의다 — 다른 운영자가 검토하고 있는 이의도 그렇게 보인다. 이 표시와 찾기는 오너가 정한 것이다(오너 결정 2026-10-23 답 4). 받는 사람은 6의 받는 사람과 같다. 기한이 지난 것의 글은 회원의 카드의 문장 그대로다.

     ```text
     이 조치는 이미 취소되었습니다.
     ```

     ```text
     이의 기한이 지났습니다.
     ```

     ```text
     이 조치에는 이미 이의를 받았습니다.
     ```

4. **검토.** 원 조치를 한 운영자도 검토할 수 있다(«같은 운영자도 가능»). 검토하는 동안 조치는 그대로 둔다 — 멈추거나 미리 취소하지 않는다. 운영자 자신에 관한 조치는 다른 운영자가 처리한다(앱도 자기에 관한 조치의 취소를 거절한다, ADR-0081). 검토하며 보는 것 가운데 신고자와 신고의 설명(`/admin/reports`), 운영 기록의 사유는 회원에게 보이지 않는 것이다 — 6의 회신에 옮기지 않는다.
5. **결과와 반영.** 결과는 유지·취소·감경이다.
   - 유지: 앱에서 바꾸는 것이 없다.
   - 취소: 그 조치의 '조치 취소'(대상 화면·회원 화면·조치 기록)를 쓰고, 운영 기록의 사유(회원에게는 보이지 않는다)에 이의를 받아들였음을 적는다. 숨긴 글·댓글은 다시 보이고 경고의 띠는 사라진다. 프로필 항목은 되살리지 않는다(#37 10항 — 회원이 다시 설정한다). 작성 제한을 취소하면 곧바로 풀리고 회원의 카드에는 끝나는 때 없이 '취소됨'과 취소한 때만 남는다 — 이미 끝난(기간이 지났거나 조기 해제한) 작성 제한도 취소할 수 있다(ADR-0082 7-15).
   - 감경: 제한의 끝나는 시각을 앞당기는 것(무기한을 기간제로 바꾸는 것 포함)이라 작성 제한·계정 제한에만 있다. 작성 제한(`writing_restriction`)은 그 회원의 운영자 화면(`/admin/moderation/users/<user_id>`)의 그 조치 줄에서 서 있는 동안 '감경'(지금 끝보다 앞이고 아직 오지 않은 때로)이나, 지금 끝내려면 '조기 해제'를 쓴다 — 둘 다 운영 기록의 사유(회원에게는 보이지 않는다)에 이의를 받아들였음을 적는다. 회원의 조치·신고 내역에는 '감경됨'·'조기 해제됨'과 바뀐 끝, '원래 끝나는 때'가 보이고 이의 기한 줄은 그대로다(ADR-0082). 조기 해제는 끝을 지금으로 앞당긴 감경이라 6의 회신에는 감경과 그 끝(해제한 때)을 적는다. 계정 제한의 감경과 해제는 #139가 더한다(다른 운영자의 승인). 경고로 낮추려면 취소한 뒤 경고를 건다(ADR-0069 결정 2 #45 14항).
6. **회신.** 결과는 이메일로 답한다. 앱의 알림은 없다(M13).
   - 받는 사람: 그 계정의 지금 이메일(`user.email`)이다. 손으로 적거나 받는 사람이 정확히 그 주소인지 보고 보내고, 이의 메일의 답장 버튼으로 정하지 않는다 — 답장 버튼은 그 메일의 `Reply-To`로 보낼 수 있다. 제재 상태와 이의는 본인 전용이라(ADR-0069 결정 2 #45 12항, 결정 3 #37 11항) 결과를 그 계정의 주소 밖으로 보내지 않는다.
   - 적는 것(오너 결정 2026-10-22 답 7): 결과 — 유지·취소·감경, 감경이면 새로 끝나는 시각(한국 시간이라고 함께 적는다) — 와 그 설명이다. 설명은 회원이 조치·신고 내역에서 이미 보는 사유, 곧 운영자가 고른 신고 사유와 회원에게 보이는 운영자 설명 안에서만 한다.
   - 적지 않는 것: 회신은 앱 안의 안내와 같은 규칙을 따른다(ADR-0069 결정 2 #45 13항 '신고자와 처리한 운영자는 보이지 않는다'·10항, 결정 3 #37 11항). 누가 신고했는지와 몇 명이 신고했는지를 적지 않고, 신고의 설명을 옮기거나 풀어 쓰지 않으며, 조치하거나 취소하거나 검토한 운영자를 — 같은 운영자여도 — 밝히지 않고, 5의 운영 기록의 사유와 그 밖의 내부 사유를 옮기지 않는다. 회원의 조치·신고 내역도 이것들을 보이지 않는다(ADR-0081).
   - 보내는 이: 고객센터 주소에서 '고객센터'의 이름으로 보내고 운영자 개인의 이름을 쓰지 않는다 — 4대로 원 조치의 운영자가 검토할 수 있으므로 개인의 이름은 처리한 운영자를 드러낸다.
7. **절차가 정하지 않은 경우.** 이 절차의 규칙이 정하지 않은 드문 경우에는 운영자가 회원에게 유리하게 판단해 처리하고, 그 판단과 까닭을 그 메일의 메일함 메모(3의 표시를 다는 곳)에 적는다(오너 결정 2026-10-23 (3차)) — 예: 발신 인증에 계속 실패해 바꾼 이메일로 다시 보낸 메일이 두 회신 동안 기한을 넘긴 것(2), 늦은 되묻기 하나에 다시 온 이의가 여럿인 것, 한 번 더 되물은 뒤에도 맞는 조치가 없거나 함께 맞은 조치 가운데 받지 않는 것이 있는 것, 기한이 모두 지난 뒤의 되묻기나 첫 메일 뒤에 받은 조치처럼 늦은 되묻기인지가 갈리는 것, 다시 온 메일이 적으라고 한 것을 빼고 적었거나 조치한 때만 맞지 않아 어느 조치인지 분명하지 않은 것(3 — 그 자리에 적은 'ADR-0084 6-8'의 읽기는 이 판단의 출발점이다).
