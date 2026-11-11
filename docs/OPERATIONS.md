# 운영 절차

배포 환경(buddha.sboh.dev)에서 운영자가 앱의 화면 없이 손으로 하는 일 — DB에서 하는 일과 고객센터 이메일로 받는 일 — 과 운영 마켓메이커 계정과 원장 계정의 확인, 계약과 담보의 확인, API 컨테이너의 메모리 확인의 절차다. 앱 안에서 처리하는 판정 이의(#175)는 화면 밖에서 알아 둘 것 — 결정할 관리자가 모자랄 때 — 만 제재 이의 처리 앞에 적는다. 판정 정정(#176)과 판정 지연 기록(#142 — 언제 기록하고 공개되는 사유에 무엇을 쓰지 않는지, 다음 검토 시각과 갱신 대기, 장기 지연 경고)도 화면에서 하는 일이고 그 앞에 운영 메모만 적는다. 운영 DB 초기화는 [RESET.md](RESET.md), 셸·시크릿·덤프 같은 인프라 일은 [terraform/README.md](../terraform/README.md)에 있다.

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
- 그 계정의 시장 제안(`market_proposals`, #77) 가운데 처리를 기다리는(접수·검토) 것과 지난 24시간에 낸 것이 새 번호의 해시로 옮겨진다(오너 결정 2026-10-25 «신고처럼 옮김», ADR-0089). 제안의 두 한도(처리 대기 5건, 지난 24시간 3건 — 철회·반려된 것도 센다)도 본인확인한 번호로 세므로(ADR-0069 결정 7), 그 두 한도가 읽는 제안이 새 번호를 따라간다 — 그 계정은 바꾼 뒤에도 하던 셈을 이어 가고, 옛 번호로 본인확인한 다음 사람은 그 제안들(그 사람의 내 제안에 없어 철회할 수도 없는 것)을 이어받지 않는다. 신고와 같다: 옮기는 것은 번호의 해시뿐이고 낸 양식과 상태·처리(검토·채택·반려·철회와 그 시각·운영자, 메모)는 그대로이며, 처리를 기다리지 않고 낸 지 24시간이 지난 제안은 어느 한도도 다시 읽지 않아 낸 때의 해시로 남는다. 그 계정이 같은 번호의 탈퇴한 계정에게서 이어받아 자기 한도에 세던 제안(옛 번호의 해시를 싣고 제안한 계정에 본인확인 기록이 없는 제안) 가운데 처리를 기다리는 것과 지난 24시간의 것도 함께 옮긴다 — 좋아요·신고처럼 3단계에서 센 옛 번호의 해시로 찾는다. 살아 있는(본인확인 기록이 있는) 다른 계정의 제안은 옛 번호의 해시에 있든 새 번호의 해시에 있든 옮기지 않는다(좋아요의 규칙과 같다, ADR-0076 결정 7-26). 제안은 번호마다 하나라는 규칙이 없어, 옮겨 오는 제안이 새 번호의 해시에 이미 있는 제안(그 번호를 가졌다가 탈퇴한 계정의 것)과 부딪히지 않으므로 지우거나 빼는 것도 없다. 제안의 기록 트리거(`market_proposals_keep_record`)는 이 트랜잭션이 `SET LOCAL`로 넘긴 계정의 제안과 옛 번호의 해시를 실은 탈퇴한 계정의 제안을 그 새 번호의 해시로 바꾸는 것만 받는다 — 앱은 그 값을 넘기지 않으므로 앱의 어떤 쓰기도 제안의 해시를 바꾸지 못한다. 5단계의 다섯째 `DO`가 하고, 결과는 `DO` 한 줄이라 읽을 것이 없다.
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

그다음 옛 번호, 곧 그 계정이 지금 가진 번호의 해시를 센다(오너 결정 2026-10-21, ADR-0076, 2026-10-22, ADR-0083, 2026-10-25, ADR-0089). 5단계는 그 계정이 같은 번호의 탈퇴한 계정에게서 이어받은 좋아요와 신고, 시장 제안도 새 번호로 옮기고(위의 '바뀌는 것', 신고는 ADR-0081, 시장 제안은 ADR-0089) 그 계정의 지난 24시간의 쓰기 셈과 링크 사용 기록도 옮기며(ADR-0083), 이어받은 것들과 쓰기 셈은 옛 번호의 해시로 찾는다. 먼저 psql(4단계)에서, 1단계에서 답장의 주소로 다시 찾은 계정의 id로 그 계정의 지금 번호를 읽는다 — 읽기만 한다. 줄이 없으면 그 계정에 본인확인 기록이 없다(그 사이에 탈퇴했다) — 아래 결과 표의 `UPDATE 0`처럼 한다.

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

찍힌 `\set old_phone` 줄의 숫자가 psql이 읽은 번호와 같은지 본다. 다르게 넣었으면 5단계의 `UPDATE`가 바꾸지 않고(그 계정이 `old_phone`을 가졌을 때만 바꾼다, 아니면 `UPDATE 0`) 첫 `DO`가 트랜잭션을 거절하므로, 다른 번호의 좋아요는 옮겨지지 않는다 — `COMMIT`해도 `ROLLBACK`이 된다(다른 번호의 신고와 쓰기 셈·링크 사용 기록, 시장 제안도 같다). 5단계를 다시 할 때마다(`UPDATE 0` 뒤나, 끊긴 세션 뒤에 같은 일을 다시 할 때) 옛 번호는 다시 읽고 다시 센다 — 바꾼 뒤에는 새 번호가 읽힌다.

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
DO $$BEGIN
  UPDATE market_proposals p SET phone_hash = current_setting('phone_change.new_hash')
    WHERE p.phone_hash <> current_setting('phone_change.new_hash')
      AND (p.status IN ('submitted', 'reviewing') OR p.created_at > now() - interval '24 hours')
      AND (p.user_id = current_setting('phone_change.user_id')
        OR (p.phone_hash = current_setting('phone_change.old_hash')
          AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = p.user_id)));
END$$;
SELECT g.user_id = :'user_id' AS this_account, n.source, g.granted_at IS NOT NULL AS paid,
    EXISTS (SELECT 1 FROM start_grants o
      WHERE o.user_id = :'user_id' AND o.cancelled_at IS NULL) AS has_grant
  FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
  WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL;
```

결과를 읽는 법(같은 SQL이 `packages/db/src/phone-change.ts`에 있고, `phone-change.test.ts`가 이 문서의 SQL이 그것과 같은지와 아래 경우마다 psql처럼 돌려 그렇게 되는지를 시험한다 — 결과마다 아래 표의 한 줄만 맞고, 그 줄의 '다음'이 말하는 `COMMIT`이나 `ROLLBACK`으로 끝낸다). `INSERT`는 새 번호를 이 계정의 지급(취소되지 않은 것)에 더한다. 새 번호를 이미 이 지급이나 지급한 지급이 붙들고 있으면 건너뛰고(`INSERT 0 0`), 금액을 기다리는 다른 지급이 붙들고 있으면 건너뛰지 않는다 — 번호마다 붙든 행은 하나라(`start_grant_numbers_phone_hash_live_idx`) 그 `INSERT`가 오류로 끝나 트랜잭션이 깨진다. 이 계정에 지급 기록이 없으면 `INSERT`에는 더할 행이 없으므로, 그 뒤의 `DO`가 같은 경우를 보고 오류로 끝낸다 — 이 계정에 본인확인 기록이 있고 새 번호를 금액을 기다리는 다른 계정의 지급이 붙들고 있으면. 그 둘이 바꾸지 않는 경우의 거절이다(오너 결정 2026-10-19와 그 3차). `UPDATE`는 그 계정이 옛 번호(`old_phone`)를 가졌을 때만 바꾼다 — 3단계에서 다른 번호를 넣었거나 바꾼 뒤에 같은 줄로 다시 돌렸으면(id를 잘못 넣었을 때도) `UPDATE 0`이다. `UPDATE 0`은 그것을 알릴 뿐 트랜잭션을 멈추지 않아 뒤의 문장도 돈다. 그래서 첫 `DO`가 먼저 이 트랜잭션의 `UPDATE`가 그 계정의 본인확인 행을 바꿨는지(`updated_at = now()::timestamptz(3)` — `now()`는 이 트랜잭션이 시작한 때이고, 그 칸처럼 밀리초까지 본다) 보고, 아니면 거절해(`refused: the account does not hold old_phone`) 트랜잭션을 깬다. 그 뒤의 `COMMIT`도 `ROLLBACK`이 되므로, `UPDATE 0`을 보지 못하고 `COMMIT`해도 `INSERT`도, 다른 번호의 해시로 옮긴 좋아요와 신고·시장 제안의 해시, 쓰기 셈과 링크 사용 기록도 남지 않는다. `DO` 앞의 `SET LOCAL` 세 줄은 계정 id와 새 번호·옛 번호의 해시를 다섯 `DO`에 넘긴다 — psql은 `$$`로 감싼 `DO` 본문에는 변수를 넣지 않는다. 그 값은 이 트랜잭션에만 있다. 마지막 줄의 칸: `this_account`는 새 번호를 붙든 지급이 이 계정의 것인지, `paid`는 그 지급을 지급했는지(`f`면 금액을 기다린다), `has_grant`는 이 계정에 취소되지 않은 지급 기록이 있는지다. 둘째 `DO`는 그 계정의 좋아요를, 셋째 `DO`는 그 계정의 처리 전 신고와 지난 24시간의 신고를(이어받은 것도), 넷째 `DO`는 그 계정의 지난 24시간의 쓰기 셈(옛 번호의 해시에 있는 것 모두)과 링크 사용 기록(그 계정의 글·댓글의 것과 이어받은 것 — 살아 있는 다른 계정의 것은 옛 번호의 해시에 있어도 그대로)을, 다섯째 `DO`는 그 계정의 처리를 기다리는(접수·검토) 시장 제안과 지난 24시간의 제안을(이어받은 것도 — 살아 있는 다른 계정의 것은 그대로) 새 번호의 해시로 옮기고(위의 '바뀌는 것') 저마다 `DO` 한 줄만 찍는다 — 표의 줄을 가르지 않으니 표는 그 줄을 빼고 읽는다. 첫 줄이 `UPDATE 0`이면 그 뒤에 무엇이 찍히든(위의 거절이나 `INSERT`의 오류도) 표의 `UPDATE 0` 줄이다. 그 밖에는, 한 문장이 오류로 끝나면 그 뒤의 문장도 `current transaction is aborted`(25P02)로 돌지 않으므로, 표에서는 첫 오류의 줄을 찾는다. 표의 `DO`에서 오류는 첫 `DO`(거절)의 것이다. `ROLLBACK`으로 끝나는 줄은 모두 거절이고 회원에게는 거절의 문장만 알린다 — `UPDATE 0`에서 id나 옛 번호를 잘못 넣은 것이 드러나 5단계를 다시 할 때만 빼고(오너 결정 2026-10-19 4차의 답 1).

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
- 5단계의 문장을 나눠 돌리지 않는다. `UPDATE`만 돌리면 새 번호가 받은 번호로 기록되지 않고, `INSERT`나 `DO`가 거절할 변경(기다리는 다른 지급의 번호)도 그대로 들어간다. 다섯 `DO`는 앞의 `SET LOCAL` 세 줄이 넘긴 값으로 보므로 그 줄들과 떼어 돌리지 않는다. 좋아요를 옮기는 둘째 `DO`를 빼면 그 계정의 좋아요가 옛 번호의 해시로 남아, 뒤에 옛 번호로 본인확인한 계정이 그 글·댓글에 누르지 못한다. 신고를 옮기는 셋째 `DO`를 빼면 그 계정이 탈퇴한 뒤 새 번호로 다시 가입한 계정이 그 계정의 처리 전 신고와 24시간의 수를 잇지 않고, 옛 번호로 본인확인한 다음 사람이 잇는다. 신고의 해시는 손으로 고치지 않는다 — 기록 트리거가 이 트랜잭션 밖의 변경을 거절한다. 기록을 옮기는 넷째 `DO`를 빼면 그 계정의 지난 24시간의 쓰기 셈과 링크 사용이 옛 번호에 남아, 그 계정은 새 번호로 처음부터 세고 뒤에 옛 번호로 본인확인한 계정이 그 셈을 이어받는다. 시장 제안을 옮기는 다섯째 `DO`를 빼면 그 계정의 처리를 기다리는 제안과 지난 24시간의 제안이 옛 번호의 두 한도에 남아, 그 계정은 새 번호로 두 한도를 처음부터 받고 뒤에 옛 번호로 본인확인한 계정이 철회할 수도 없는 그 제안들을 한도에 이어받는다. 제안의 해시도 손으로 고치지 않는다 — 기록 트리거가 이 트랜잭션 밖의 변경을 거절한다. 옛 번호의 두 줄은 짐작하거나 앞서 찍은 것을 다시 쓰지 않는다 — 5단계를 할 때마다 그 계정의 지금 번호를 읽어 CLI로 센다(3단계). 그 계정의 번호가 아닌 번호의 해시는 다른 사람의 좋아요와 신고, 쓰기 셈과 링크 사용 기록, 시장 제안을 그 계정에 옮기고 새 번호에 있던 다른 좋아요를 지우게 되므로, `UPDATE`가 `old_phone`으로 보고(아니면 `UPDATE 0`) 첫 `DO`가 그 트랜잭션을 거절한다 — `UPDATE 0`은 알림일 뿐이고, 막는 것은 그 거절이다(`COMMIT`해도 `ROLLBACK`이 된다). 차례도 바꾸지 않는다 — 번호를 바꾸는 `UPDATE`가 그 계정의 본인확인 행을 쥔 뒤에 옮겨야, 그 계정이 그사이에 누른 좋아요와 낸 신고·시장 제안, 센 쓰기도 옮겨지고(좋아요와 신고, 센 쓰기는 그 행을 쥐고 쓰고, 시장 제안은 그 행을 쥐고 번호를 읽는다) 커밋 뒤의 것은 새 번호로 쓰인다. 거절된 변경은 회원이 다시 요청할 때 1단계부터 다시 한다 — 거절 전에 받은 확인으로 5단계만 다시 하지 않는다.
- 해시를 다른 곳에서 세지 않는다. 다른 키로 센 해시는 어느 번호와도 맞지 않아 기록해도 아무것도 막지 못한다.
- 번호의 기록은 번호를 바꾼 계정의 지급에만 더한다. 탈퇴로 취소된 지급(금액을 기다리다 탈퇴한 계정, ADR-0071)에는 더할 수 없다 — 트리거가 거절한다.

**로컬.** 같은 일을 개발 스택에서 해 보려면, `.env`의 `PHONE_HASH_KEY`(비워 두면 개발용 키)로 해시를 세고 개발 DB에 붙는다.

```bash
corepack pnpm --filter api build
corepack pnpm --filter api run phone-hash --psql
corepack pnpm --filter api run phone-hash --psql-old
docker compose exec -e PSQL_HISTORY=/dev/null postgres psql -U buddha_app -d buddha
```

## 운영 마켓메이커 계정 (#115, ADR-0108)

운영 마켓메이커 계정은 봇(M10 #129)이 주문하는 계정 하나다(ADR-0107 결정 2 #73 11항). 계정 유형은 '일반 사용자'와 '운영 마켓메이커' 둘이고(결정 4 #115 행), 이 계정만 '운영 마켓메이커'다. 운영자가 할 일은 없다 — 아래는 알아 둘 것과 읽기만 하는 확인이다.

- **누가 만드나.** 시드만 만든다. 배포의 `migrate`가 도는 시드가 그 계정이 없을 때만 하나 만들고(`[db:seed] market maker account: created`), 있으면 그대로 둔다(`… exists`). `SEED_ADMIN_*`와 상관없다. 둘째는 DB가 거절한다(`user_market_maker_uidx`). 운영 DB를 비우면(#116, [RESET.md](RESET.md)) 다음 시드가 새 id로 다시 만든다 — 그 id를 어디에 적어 두지 않는다.
- **로그인하지 않는다.** 비밀번호·소셜 로그인·세션이 없고, 주소(`market-maker@noemail.buddha.local`)는 메일이 가지 않는 서비스의 주소라 로그인·비밀번호 재설정·인증 메일이 모두 거절한다. DB도 그 계정의 세션·로그인 수단·비밀번호 재설정 행을 받지 않는다.
- **프로필이 없다.** 닉네임·소개·이미지·공개 id가 없어 공개 프로필은 없는 계정처럼 404다. 글·댓글·좋아요·신고·시장 제안을 서버가 거절하고 DB도 그 행을 받지 않는다. 그래서 `/admin/users`와 운영자 화면에도 보이지 않는다 — 관리자 화면에 '운영 마켓메이커'라는 이름으로 보이는 것은 봇 관리 화면(M10 #182)부터다.
- **관리자가 될 수 없다.** 관리자 권한(`profiles.role`)은 계정 유형과 따로 있고 프로필에 있다. 프로필이 없으니 `/admin/admins`의 부여는 그 계정을 찾지 못하고(없는 계정처럼 404), 시드도 그 주소를 관리자로 받지 않는다. 계정 제한·경고도 같은 까닭으로 404다(잔고 조정은 #116이 모든 계정에서 없앴다) — 봇을 멈추는 것은 계정 조치가 아니라 봇의 중단 스위치(M10 #130)다.
- **Coin.** 시작 Coin을 받지 않고(API와 DB가 거절한다) 사용자 원장 계정도 잔고 행도 없다 — 사용자 원장 계정은 사람 계정의 것이고 DB가 이 계정의 것을 거절한다(#116, ADR-0109). 봇이 쓸 Coin은 시장마다의 '마켓메이커 자금' 원장 계정(`ledger_accounts`의 `market_maker_funds`, 주인이 이 계정)에 두고, 그 원장 계정은 봇이 그 시장에 처음 배정받을 때(M10 #129) 생긴다. 아래 [원장 계정](#원장-계정-116-adr-0109).
- **쌍 소각.** 이 계정이 한 시장에서 잠기지 않은 YES와 NO를 함께 가지면 봇(M10 #129)이 그 수만큼 바로 소각하고, 쌍마다 100 Coin이 그 시장의 담보에서 마켓메이커 자금으로 돌아온다('쌍 소각 반환', ADR-0107 결정 2 #73 12항). 거래 중·거래 일시 중단인 시장에서 거래 마감 시각 전에만 하고, 마감 뒤와 '담보·원장 장애' 일시 중단 동안에는 하지 않는다(이미 다른 사유로 일시 중단된 시장에 기록된 원장 장애는 아직 막지 않는다 — 그 기록을 만드는 #93이 소각 거절에 더한다). 운영자가 할 일은 없다. 아래 [계약과 담보](#계약과-담보-118-adr-0110).
- **체결.** 이 계정의 주문도 회원의 주문과 같은 매칭 규칙으로 체결한다(#117, ADR-0111). 봇은 매수 호가만 내므로 회원이 봇에게서 계약을 사는 것은 늘 반대 결과 매수의 쌍 발행이고, 봇의 매수 호가에 바로 파는 것은 계약을 가진 회원의 매도다. 사람이 아닌 계정은 모두 한 자기 체결 묶음이라 봇끼리는 체결하지 않는다(봇의 YES 매수와 NO 매수도 쌍을 만들지 않는다). 운영자가 할 일은 없다.
- **사람 수에서 빠진다.** 참여자 수·'사용자 체결 0건'과 판정 이의의 자격은 사람 계정만 센다(ADR-0107 결정 1 #177 13항). 사람 계정인지는 한 규칙(`isHumanAccountType`, SQL `is_human_account`)으로만 가린다. 참여자 수(#121)는 주문 접수가 책을 읽을 때 그 규칙으로 가린 주인(`OrderOwner.human`)으로 세고, 확인 SQL은 체결에 복사한 계정 유형으로 다시 센다([시장 통계](#시장-통계-121-adr-0116)). 거래량은 사람 계정이 한쪽인 모든 체결을 센다(봇과의 체결 포함, #177 12항) — 봇끼리의 체결은 생기지 않으므로(0062 `fills_check`) 모든 체결이다.

**확인(읽기만).** [휴대전화 번호 바꾸기](#회원의-휴대전화-번호-바꾸기-57-3항)의 2단계(셸)와 4단계(psql)로 붙어 돌린다. 줄이 하나이고 `profiles`·`sign_ins`·`sessions`·`user_ledger_accounts`가 0이어야 한다. `funds_accounts`는 봇이 자금을 둔 시장의 수다(#129 전에는 0). 줄이 아예 없을 때만 아직 시드가 돌지 않은 DB다 — 손으로 만들지 않고 호스트 셸에서 시드를 돌린다(`sudo docker compose -f /data/buddha/compose.yaml run --rm migrate`, 초기화가 [RESET.md](RESET.md) 8단계에서 도는 것과 같은 일).

```sql
SELECT u.id, u.created_at, u.email_verified,
  (SELECT count(*) FROM profiles p WHERE p.user_id = u.id) AS profiles,
  (SELECT count(*) FROM account a WHERE a.user_id = u.id) AS sign_ins,
  (SELECT count(*) FROM session s WHERE s.user_id = u.id) AS sessions,
  (SELECT count(*) FROM ledger_accounts l
    WHERE l.owner_id = u.id AND l.kind = 'user') AS user_ledger_accounts,
  (SELECT count(*) FROM ledger_accounts l
    WHERE l.owner_id = u.id AND l.kind = 'market_maker_funds') AS funds_accounts
FROM "user" u
WHERE NOT is_human_account_type(u.account_type);
```

계정 유형은 고치지 않는다 — 어느 롤로도 DB 트리거(`user_keep_account_type`)가 거절한다.

## 원장 계정 (#116, ADR-0109)

원장은 원장 계정 사이의 이동이다(ADR-0107 결정 2 #73 1·11항). 원장 계정은 넷이다: 사람 계정마다의 사용자 계정(`user`, 가입 트리거가 잔고 0으로 연다 — 관리자·탈퇴한 계정도 사람이다), 운영 금고 하나(`treasury`), 시장마다의 담보(`market_collateral`)와 마켓메이커 자금(`market_maker_funds`, 주인은 운영 마켓메이커). 금고·담보는 주인이 없다. 사용자 계정 밖의 셋은 처음 쓰일 때 생긴다 — 담보는 그 시장의 첫 쌍 발행(#118의 처리를 #119의 체결이 부른다), 금고와 마켓메이커 자금은 금고 발행과 봇 배정(M10 #129)이다. 그래서 #129 전에는 금고가 없다. 운영자가 할 일은 없다 — 아래는 알아 둘 것과 읽기만 하는 확인이다.

- **손으로 바꾸지 않는다.** 원장 행은 어느 롤로도 고치거나 지우지 못하고(트리거 `ledger_entries_keep_record`), 원장 계정도 그렇다(`ledger_accounts_check`). 잔고 행은 원장이 말하는 그 계정의 합을 `ledger_coin`에 옮겨 적고, 원장 이벤트마다 내거나 받는 칸(가용·잠금)과 그것이 함께 움직인다. 잔고의 합(가용 + 잠금)만 바꾸는 UPDATE는 DB가 그 자리에서 거절하고(`balances_keep_ledger_gap` — 합과 `ledger_coin`의 차이는 어느 UPDATE로도 바뀌지 않는다), 이벤트 없이 둘을 함께 바꾸면 커밋 때 거절한다(`balances_follow_ledger`). `buddha_app`은 잔고 행을 넣거나 지우지 못하고 금액 열만 바꾼다.
- **관리자의 잔고 조정은 없다**(증감 모두, ADR-0107 결정 2 #73 7항). 관리자가 회원에게 Coin을 주거나 거두는 길도, 운영 사고를 보상하는 길도 없다 — 판정 오류 보상(#144)과 재지급(#74) 전의 공백은 오너가 받아들였다(D4).
- **불일치.** #93 구현분의 시장·계정·총량 대사는 불변 관측을 `reconciliation_results`에, 실패를 `audit_failures`의 `market_reconciliation_mismatch`·`account_reconciliation_mismatch`·`supply_reconciliation_mismatch`에 남긴다. 거래 중 시장은 자동 중단하고 사람 계정은 새 주문만 보류하며 총량·금고 실패는 전역 거래를 멈추지 않는다. 통과 관측만으로 보류를 풀지 않는다. [대사와 보류 복구](#대사와-보류-복구-93-adr-0119) 절에서 수동 검사와 다른 관리자의 복구 승인을 진행한다. Coin 보정은 실패 결과와 현재 장부에서 계산한 후보에 묶인 2인 승인으로만 실행한다. 금고 부족은 대기하며 본인에게 사용자용 사유만 표시한다. 일반 원장 이벤트는 기존 가용+잠금과 `ledger_coin` 사이의 차이를 보존하고, 원장 사본이 실제 체인과 같을 때만 취소·정산 등 기존 쓰기를 수행한다. 계정 보류가 그 계정이 가진 시장의 정산 전체를 막는 것은 아니다. 원장이 가진 것보다 많이 낼 수 없고, 탈퇴는 차이가 닫혀 모두 0이 되기 전 거절된다. 기존 `ledger_balance_mismatch` 실패 기록은 보존한다.
- **사본이 어긋났을 때(`ledgerCoinMismatch` 참).** `ledger_coin`마저 원장 합과 다르면 — 예컨대 트리거 없이 `balances`만 옛 백업에서 되살려 가용과 사본이 함께 옛 값일 때 — 그 원장 계정은 **어떤 원장 이벤트도 받지 못한다**(ADR-0109 결정 12-8): 이벤트의 거래 후 잔고는 원장에서 이어야 하고 커밋 때 `ledger_coin`이 그와 같아야 한다. 시작 지급과 체결이 거절되고, 그 계정이 보유한 시장은 지급 트랜잭션이 통째로 되돌아가 정산 중에 머문다(워커 로그에 `does not continue its accounts' totals`가 매 분 남는다). 이것만은 #93을 기다리지 않고 오너가 사본만 원장 합으로 되돌린다 — Coin은 움직이지 않고 원장도 그대로이며, 가용 + 잠금과 원장의 차이는 위의 차이로 남아 이벤트를 받는다. 호스트에서 postgres 롤로 붙어(`sudo docker compose -f /data/buddha/compose.yaml exec -e PSQL_HISTORY=/dev/null postgres psql -U postgres -d buddha`) 감사가 남긴 원장 계정 id를 `:id`로 넣고 한 트랜잭션으로 돌린다. 차이를 지키는 트리거를 그 트랜잭션에서만 끄므로 다른 줄을 더하지 않는다. `UPDATE 1`이 아니거나 `SET CONSTRAINTS`가 오류를 내면 `ROLLBACK`한다. 다음 감사에서 `ledgerCoinMismatch`가 거짓이 되고 차이(`differenceCoin`)만 남는다.

  ```sql
  \set id 123
  BEGIN;
  ALTER TABLE balances DISABLE TRIGGER balances_keep_ledger_gap;
  UPDATE balances SET ledger_coin = ledger_account_last_after(account_id), updated_at = now()
    WHERE account_id = :id;
  SET CONSTRAINTS ALL IMMEDIATE;
  ALTER TABLE balances ENABLE TRIGGER balances_keep_ledger_gap;
  COMMIT;
  ```

**확인(읽기만).** 위와 같이 psql로 붙어 돌린다. 첫째는 사용자 계정 밖의 원장 계정과 그 잔고(가용·잠금과 원장 합 `ledger_coin`)다(주문 접수가 열리기 전과 #129 전에는 줄이 없다). 둘째는 전체의 보존이다: `carried`(원장 합의 합)가 `minted − burned`와 같아야 하고(발행은 보내는 계정이 없는 이벤트, 소각은 받는 계정이 없는 이벤트 — 소각은 탈퇴 소멸 하나다, 16항), 잔고가 원장과 어긋난 계정이 없으면 `held`도 같다. `held`와 `carried`가 다르면 그 차이가 어긋난 계정들의 차이의 합이다.

```sql
SELECT l.id, l.kind, l.market_id, b.available_coin, b.locked_coin, b.ledger_coin
FROM ledger_accounts l LEFT JOIN balances b ON b.account_id = l.id
WHERE l.kind <> 'user'
ORDER BY l.kind, l.market_id;

SELECT
  (SELECT coalesce(sum(available_coin + locked_coin), 0) FROM balances) AS held,
  (SELECT coalesce(sum(ledger_coin), 0) FROM balances) AS carried,
  (SELECT coalesce(sum(amount_coin), 0) FROM ledger_entries WHERE from_account_id IS NULL) AS minted,
  (SELECT coalesce(sum(amount_coin), 0) FROM ledger_entries WHERE to_account_id IS NULL) AS burned;
```

## 대사와 보류 복구 (#93, ADR-0119)

대사·지속 보류·보정·2인 복구를 구분한다. 배포하면 자동 중단 잡이 켜지며 보정은 다른 관리자의 승인으로만 실행하므로 머지는 오너 승인을 기다린다. 0065는 새 결과/보류/보정/복구 표와 검사, 시스템 중단자 NULL의 조건, `ledger_hold` 주문 거절을 추가한다. 마이그레이션 자체는 기존 행을 고치거나 지우지 않는다. `order.accepting`은 #126과 완료된 #93 배포 뒤 오너가 연다.

시장은 미검사·새 시장 원장 이벤트·마지막 실패를 매 분 최대 500개 검사한다. 계정·총량은 매일 04:00 KST에 검사하며 수동 검사도 같은 공통 함수를 쓴다. 시장 담보·마켓메이커 자금·계약·주문 잠금, 사람 계정의 모든 시장 매수 잠금과 원장, 발행−소각 총량을 대조한다. 지급 중·지급 완료 시장은 #126의 영구 정산 사실과 실제 지급/담보 원장도 확인한다. 이벤트 없는 모든 잠금 손상을 매 분 전수 조사하거나 통계를 자동 정정하지는 않는다.

시장 불일치는 지속 보류를 만들고 OPEN이면 `ledger_failure`로 자동 중단한다. 시스템 중단은 `paused_by=NULL`과 고정 문장 ‘담보·원장 대사에서 불일치가 확인되어 거래를 일시 중단했습니다.’로 구별한다. 다른 사유의 기존 중단은 바꾸지 않는다. SCHEDULED 보류는 검사 통과 뒤에도 복구 전 개장을 막고, 마감 뒤 보류는 판정을 허용하되 지급을 보류한다. 계정 불일치는 해당 사람의 새 주문만 막고, 취소·정산은 기존 원장 검사를 따른다. 총량·금고 실패로 전역 접수를 멈추지 않는다.

1. `/admin/audit-failures`에서 대상·최근 실패/통과·예상값/실제값을 확인한다. 최근 통과가 있어도 활성 보류는 남는다. 옛 `ledger_failure` 중단과 `closed_at_close` 기록도 복구 전까지 실효 보류이며 첫 검사에서 새 보류와 연결한다. 이때 실패 결과 id가 NULL일 수 있다.
2. 서버가 지원하는 Coin 차이는 아래 보정 절차로 요청한다. 수량·주문 잠금·원장 사본 손상 등 후보가 없는 문제는 Coin을 임의로 넣어 덮지 않는다. 위의 오너 전용 **원장 사본만** 복원하는 절차를 일반 잔고 보정이나 보류 해제로 대신 쓰지 않는다.
3. ‘다시 검사’를 실행한다. 새 결과·실패·보류를 쓸 수 있고 시장을 자동 중단할 수도 있다. 실패 관측을 영구 기록하려면 이 수동 재검사를 사용한다.
4. 통과한 활성 보류의 복구를 사유와 함께 요청하고 다른 관리자가 승인한다. PAUSED는 시장 상세의 기존 재개/조기 마감 요청을 사용한다. 요청의 `holdId`·`failureResultId`는 고정되므로 재실패 뒤의 낡은 요청은 반려/철회하고 다시 요청한다. 반려/철회는 보류를 풀지 않는다.
5. 승인 트랜잭션 안의 새 대사가 통과해야 보류가 끝난다. 실패하면 승인·그 검사·복구·주문 변경 전부 롤백되어 대기 요청이 남는다. 성공하면 PAUSED의 남은 주문은 ‘취소 완료(일시 중단)’, 이미 마감/취소된 시장의 주문은 ‘만료’로 끝난다. 마감/취소 상태를 되돌리지 않는다. 계정 복구는 기존 주문을 취소하지 않고 새 주문 보류만 푼다. SCHEDULED 복구도 개장 자체를 대신하지 않는다.

**Coin 보정.** 실패 결과의 ‘보정’에서 서버가 계산한 대상·금액·전후 값을 확인한다. 임의 금액은 입력하지 않는다. 원장이 올바른데 실제 잔고가 90이면 100까지 부족한 10만 복원한다. 원장·발행 누계는 바꾸지 않고 상대방 금고 이동 없이 복원 사실을 영구 기록한다. 대상 자체가 금고이면 그 금고의 실제 부족만 복원한다. 실제 잔고가 110·원장이 100이면 금고에서 대상 **원장만** 10 보충하며 대상의 실제 잔고는 110 그대로다. 시장 담보는 계약과 지급 의무가 맞을 때만 정확한 부족분을 금고에서 충당하거나 초과분을 금고로 반환한다. 사용자 실제 Coin 차감·기지급 정산 회수·과거 원장 수정은 없다.

내부 사유와 사용자용 사유를 구분해 요청하고 다른 관리자가 승인한다. 사용자용 사유는 대상 사용자 본인의 지갑 보정 이력에만 표시한다. 내부 감사 상세·요청/승인 사유·관리자 신원은 공개하지 않는다. 원장 보충은 본인 이력에서 **실제 잔고 변화 없음**으로 구분한다. 실제 잔고만 복원한 기록을 가짜 송금 원장으로 만들지 않는다.

금고가 부족하면 승인과 모든 쓰기를 되돌려 요청을 대기 상태로 유지한다. #129의 금고 발행 절차로 재원을 마련한 뒤 다른 관리자가 다시 승인한다. 금고 음수를 허용하거나 재원 마련 뒤 자동 승인하는 잡은 없다. 같은 문제의 반복 검사나 금고 잔액만 바뀐 것은 대기를 무효화하지 않지만, 대상 장부·필요 금액이 바뀌면 낡은 요청을 반려/철회하고 새 후보를 확인한다. 전역 보정 대기 목록에서 이전 검사에 연결된 요청도 찾을 수 있다. 보정 뒤 새 대사가 통과하더라도 보류는 위의 별도 복구 승인이 끝나야 해제된다.

수동 CLI는 **읽기 전용이 아니다**. 대사 결과·실패·보류·시장 자동 중단을 쓸 수 있다. 인자가 없으면 전체, selector는 아래 중 하나만 받는다. 잘못된 인자는 연결 전에 거절한다. JSON 결과를 출력하며 불일치나 실행 오류가 하나라도 있으면 종료 코드 1, 전부 통과하면 0이다. Coin 보정·보류 해제는 하지 않는다.

```sh
pnpm --filter worker run job:ledger-audit
pnpm --filter worker run job:ledger-audit --market-id <UUID>
pnpm --filter worker run job:ledger-audit --user-id <USER_ID>
pnpm --filter worker run job:ledger-audit --account-id <ACCOUNT_ID>
pnpm --filter worker run job:ledger-audit --supply
```

운영 호스트의 기존 worker 이미지 명령에도 같은 selector를 붙일 수 있다. 이 문서 작업은 아래 명령을 실행하지 않았다.

```sh
sudo docker compose -f /data/buddha/compose.yaml exec worker node apps/worker/dist/scripts/run-ledger-audit.js --supply
```

**확인(읽기만).** 다음 SELECT 4개는 2026-11-09에 전용 `buddha_m93_test`(테스트 Postgres 5433)의 `BEGIN READ ONLY` 트랜잭션에서 실행 성공을 확인한 뒤 롤백했다. 운영 실행 결과가 아니다. 아래 조회는 기록된 관측을 읽으며 상태를 고치지 않는다. 전체 실패 원인은 최신 관측의 `findings`와 `facts`를 함께 확인한다.

활성 보류와 가장 최근 관측. `latest_passed=true`여도 `recovered_at`이 비어 있으면 2인 복구를 기다리는 보류다.

```sql
SELECT h.id AS hold_id, h.target_key, h.scope, m.status AS market_status,
       h.failure_result_id, h.legacy_pause_id, h.started_at,
       r.id AS latest_result_id, r.passed AS latest_passed,
       r.checked_at, r.source, r.findings
FROM reconciliation_holds h
LEFT JOIN markets m ON m.id = h.market_id
LEFT JOIN LATERAL (
  SELECT id, passed, checked_at, source, findings
  FROM reconciliation_results
  WHERE target_key = h.target_key
  ORDER BY id DESC LIMIT 1
) r ON true
WHERE h.recovered_at IS NULL
ORDER BY h.started_at, h.id;
```

첫 검사 전의 옛 중단을 포함한 실효 시장 보류. 두 조건 중 하나라도 참이면 보류이며, `closed_at_close`도 새 복구 기록이 생기기 전에는 보류다.

```sql
SELECT m.id, m.status,
       EXISTS (
         SELECT 1 FROM reconciliation_holds h
         WHERE h.market_id = m.id AND h.recovered_at IS NULL
       ) AS persistent_hold,
       EXISTS (
         SELECT 1 FROM market_pauses p
         WHERE p.market_id = m.id AND p.reason = 'ledger_failure'
           AND (p.ended_at IS NULL OR p.end_kind = 'closed_at_close')
           AND NOT EXISTS (
             SELECT 1 FROM reconciliation_recoveries r WHERE r.legacy_pause_id = p.id
           )
       ) AS legacy_hold
FROM markets m
WHERE EXISTS (
  SELECT 1 FROM reconciliation_holds h
  WHERE h.market_id = m.id AND h.recovered_at IS NULL
) OR EXISTS (
  SELECT 1 FROM market_pauses p
  WHERE p.market_id = m.id AND p.reason = 'ledger_failure'
    AND (p.ended_at IS NULL OR p.end_kind = 'closed_at_close')
    AND NOT EXISTS (
      SELECT 1 FROM reconciliation_recoveries r WHERE r.legacy_pause_id = p.id
    )
)
ORDER BY m.id;
```

최신 총량 관측과 복구 근거의 읽기. 실제 지금 상태는 수동 검사를 수행하기 전까지 이 관측 시각의 상태와 다를 수 있다.

```sql
SELECT id, checked_at, passed, source, facts, findings
FROM reconciliation_results
WHERE target_key = 'supply'
ORDER BY id DESC LIMIT 1;

SELECT h.target_key, r.hold_id, r.result_id, r.approval_id,
       r.requested_by, r.approved_by, r.recovered_at, r.legacy_pause_id
FROM reconciliation_recoveries r
JOIN reconciliation_holds h ON h.id = r.hold_id
ORDER BY r.recovered_at DESC, r.id DESC LIMIT 100;
```

## 계약과 담보 (#118, ADR-0110)

계약은 완전 담보다(ADR-0107 결정 1 #177 1항). YES·NO 한 쌍의 담보는 계약당 정상 지급과 같은 100 Coin이고, 시장마다 정산되지 않은 YES의 수와 NO의 수가 같으며, 그 시장의 담보는 정산되지 않은 쌍 × 100 Coin이다. 계약 값(정수 1계약, 지급 100 Coin, 틱 1 Coin, 가격 1–99 Coin, 무효면 계약마다 50 Coin)은 모든 시장에 같은 코드 고정값이라 운영자가 넣거나 바꾸는 값이 아니다([SETTINGS.md](SETTINGS.md) '출시 설정이 아닌 것'). 주문 접수(`order.accepting`)가 열리기 전에는 운영에 계약도 주문 잠금도 없다 — #119가 그 설정을 닫힌 채로 등록하고, 오너가 #126·#93이 운영에 배포된 뒤 관리자 화면에서 연다(ADR-0107 결정 3). 운영자가 할 일은 없다 — 아래는 알아 둘 것과 읽기만 하는 확인이다.

- **계약이 생기고 없어지는 길.** 계약은 반대 결과의 두 매수가 맞물린 체결(쌍 발행, D17)로만 생긴다: YES 매수자의 잠금에서 YES 가격 × 수량이, NO 매수자의 잠금에서 (100 − YES 가격) × 수량이 그 시장의 담보로 간다('쌍 발행 담보' 두 줄). 같은 계약의 체결은 주인만 바꾸고(매수자의 잠금에서 매도자에게 '체결 대금', 담보는 그대로), 계약은 운영 마켓메이커의 쌍 소각과 정산으로만 없어진다. 한쪽 결과만 만들거나 없애는 길은 없다. 회원에게는 쌍 발행·상환(소각)의 화면도 API도 없어(#177 6항) YES와 NO를 함께 가진 회원은 정산까지 보유한다 — 한 쌍은 어느 결과에서나 100 Coin이다.
- **주문 잠금.** 매수는 한도가격 × 수량의 Coin을(금액으로 낸 즉시 매수는 예산 전체를, #177 3항), 매도는 그 수량의 계약을 잠근다. Coin 잠금은 같은 원장 계정의 가용 → 잠금(`balances.locked_coin`)이고, 계약 잠금은 보유 행의 `positions.locked_qty`(보유 수량을 넘지 못한다)다. 둘 다 원장 이벤트가 아니고 주문 행이 근거다(#73 1항). 운영 마켓메이커의 Coin 잠금은 그 시장의 마켓메이커 자금에서 한다. 더 나은 가격의 차액, 남은 예산, 취소·만료는 잠금을 그 계정의 가용으로 푼다. 한 계정의 여러 시장 잠금이 가용을 넘지 못한다. '잠금 = 살아 있는 주문의 남은 잠금 합'의 대사는 #93이다.
- **봇의 쌍 소각.** 위 [운영 마켓메이커 계정](#운영-마켓메이커-계정-115-adr-0108)의 '쌍 소각'. 잠긴(대기 매도에 걸린) 계약은 소각하지 않고, 회원의 보유도 소각하지 않는다. 체결이 아니라서 시장가격·거래량·차트에 들지 않는다.
- **손으로 바꾸지 않는다.** 보유(`positions`)의 수량과 잠금, 담보의 잔고를 손으로 고치지 않는다. 아래 확인에서 어긋난 줄이 보이면 오너에게 알리고 [대사와 보류 복구](#대사와-보류-복구-93-adr-0119) 절을 따른다. 지원되는 Coin 차이는 보정 요청과 다른 관리자 승인으로만 닫고, 수량·잠금 손상을 Coin으로 덮지 않는다. 정산은 살아 있는 매수·매도, 보유 잠금, 시장 전용 마켓메이커 자금의 잠금이나 원장 장애 보류가 남으면 지급을 시작하지 않고 그 시장이 정산 중(SETTLING)에 머물며 매 분 다시 시도한다(#126, ADR-0118). 마감이 남은 대기 주문을 만료하므로(#120, [시장 마감과 주문 만료](#시장-마감과-주문-만료-120-adr-0115)) 이제는 두 경우에만 생긴다: 담보·원장 장애로 묶인 채 마감한 시장 — 그 시장의 복구(#93)가 잠금을 풀면 다음 시도가 끝낸다 — 과, #120 배포 전에 마감해 대기 매도가 남은 시장(#120은 그 주문을 쓸지 않는다, ADR-0115 10-14) — 그 주인의 취소(#178, ADR-0113 12-9)가 잠금을 풀면 다음 시도가 끝낸다. 뒤의 것은 [주문 취소](#주문-취소-178-adr-0113)의 확인 (a)가 보인다(운영에는 주문 접수가 열린 적이 없어 없다).

**확인(읽기만).** [원장 계정](#원장-계정-116-adr-0109)과 같이 psql로 붙어 돌린다. 보유나 담보 원장 계정이 있는 시장마다 한 줄이다(주문 접수가 열리기 전에는 줄이 없다). `yes`·`no`는 정산되지 않은 보유의 합, `locked_yes`·`locked_no`는 그 가운데 대기 매도가 잠근 것, `collateral`은 그 시장 담보의 원장 합(`ledger_coin`)이다. 줄마다 `balanced`가 참이어야 한다(`yes` = `no`이고 `collateral` = `yes` × 100). 정산을 마친 시장은 모두 0이다. 거짓인 줄은 차례의 맨 앞에 온다.

```sql
SELECT m.id, m.status,
  coalesce(p.yes, 0) AS yes, coalesce(p.no, 0) AS no,
  coalesce(p.locked_yes, 0) AS locked_yes, coalesce(p.locked_no, 0) AS locked_no,
  coalesce(b.ledger_coin, 0) AS collateral,
  coalesce(p.yes, 0) = coalesce(p.no, 0)
    AND coalesce(b.ledger_coin, 0) = coalesce(p.yes, 0) * 100 AS balanced
FROM markets m
LEFT JOIN (
  SELECT market_id,
    sum(qty) FILTER (WHERE outcome = 'YES') AS yes,
    sum(qty) FILTER (WHERE outcome = 'NO') AS no,
    sum(locked_qty) FILTER (WHERE outcome = 'YES') AS locked_yes,
    sum(locked_qty) FILTER (WHERE outcome = 'NO') AS locked_no
  FROM positions WHERE NOT settled GROUP BY market_id
) p ON p.market_id = m.id
LEFT JOIN ledger_accounts l ON l.market_id = m.id AND l.kind = 'market_collateral'
LEFT JOIN balances b ON b.account_id = l.id
WHERE p.market_id IS NOT NULL OR l.id IS NOT NULL
ORDER BY balanced, m.id;
```

## 완전 담보 정산 (#126, ADR-0118)

결과 확정 뒤 워커가 자동으로 정산을 시작한다. YES·NO 결과는 이긴 계약마다 100 Coin, 진 계약마다 0이고, 무효는 YES·NO 각각 50이다. 매입 원가를 돌려주는 방식이 아니며 수수료는 0이다. 무효 판정을 승인한 다른 관리자의 승인이 운영 승인이고 지급 때 다시 승인하지 않는다. 계정 제한 중에도 지급하며 봇은 해당 시장의 마켓메이커 자금으로 받는다. 봇 자금의 금고 회수는 SETTLED/CANCELLED 커밋 뒤 별도 자동 작업으로 진행한다(#181, ADR-0125). 회수 실패는 사용자 지급 완료를 되돌리지 않는다.

- **배포 효과와 승인.** 새 설정은 없다. 이미 RESOLVED/SETTLING인 시장도 다음 실행에서 새 검사와 지급을 따르고 확정된 VOID 시장도 지급을 시도하므로 머지는 오너 승인을 받는다. 마이그레이션 0064는 영구 기록 표와 방어만 더하고 기존 기록을 지우거나 채우지 않는다. 이미 SETTLED인 옛 시장은 다시 지급하지 않는다. 주문 접수는 #93까지 배포된 뒤 오너가 연다.
- **기록.** 정산 전 양수 보유마다 `position_settlements`에 수량·원가·최종 판정/규칙 버전·결과·단가·지급액·정산 손익·지급 원장·시각을 남긴다. 진 계약의 0 지급도 기록한다. 이미 전량 매도해 수량 0이면 기록을 만들지 않는다. 정산 손익은 지급액 − 남은 원가이며 기존 누적 실현 손익에 더한다. 기록은 수정·삭제하지 않는다. 개인 정산 이력 화면은 #124다. 공개 판정 기록(#24, ADR-0121)은 개인 지급액·보유·손익 없이 결과 확정/지급 완료 시각과 지급 지연 여부를 보인다.
- **한 번 지급.** SETTLING 시작은 먼저 커밋하고, 모든 지급·계약 소멸·기록·최종 대사·SETTLED는 시장별 한 트랜잭션이다. 한 건이라도 실패하면 그 지급 트랜잭션 전부가 롤백된다. 숫자 판정 버전은 기존 원장 키를 유지하고 NULL인 옛 판정은 `legacy` 키로 구별한다. 실제 판정 버전이 있으면 확정된 승인 기록과 규칙이 맞아야 한다.
- **지급 실패.** 살아 있는 매수/매도, 보유 잠금, 원장 장애 복구 보류, 부족/초과 담보, 계약 수량 불일치, 닫힌 계정의 양수 보유, 판정·영구 기록·지급 원장 불일치는 실패로 남고 SETTLING에서 매 분 다시 시도한다. 다른 시장 주문이 사람 지갑에 잠근 Coin은 막지 않는다. 지급이 대기 주문을 취소하지는 않는다. 원장 장애 시장은 [대사와 보류 복구](#대사와-보류-복구-93-adr-0119)의 최신 통과·2인 승인 뒤 복구하고, 옛 비보류 주문의 본인 취소는 #178이다. 실패 목록·운영자 재시도는 #145다.
- **완료 뒤 대사 실패.** 관리자 시장 상세의 정산 단계에 시도 수와 마지막 오류가 보인다. 시장이 SETTLING에 남고 `coin`이 `done`이며 마지막 오류가 있으면 최종 대사 실패를 확인한다. 성공해 SETTLED로 끝난 뒤에도 마지막 오류는 이전 실패 이력으로 남을 수 있으므로 오류 문자열만으로 현재 실패라고 판단하지 않는다. 완료 표시는 유지해 재지급을 막으며 다음 시도도 대사를 다시 한다. 단계의 완료 표시만으로 지급 완료가 되지 않는다. 원인과 원장·보유·담보를 확인하고 손으로 수정하지 않는다. 결과 확정 시각(`resolved_at`)과 지급 완료 시각(`settled_at`)은 구별한다.

**확인(읽기만).** 정산 기록과 연결된 원장 금액을 시장·계약별로 본다. 지급 0인 기록의 `ledger_entry_id`는 NULL이고 그 밖은 `SETTLEMENT_PAYOUT` 한 행이다. 위 '계약과 담보' SQL은 미정산 보유만 읽으므로 완료 행에 남은 수량·원가나 봇 자금 잠금을 확인하지 못한다. 아래 두 번째 SQL은 지급 완료 시장의 모든 보유 행과 담보의 실제 원장 잔액, 시장 자금의 잠금을 따로 확인한다. 원장 키나 기록을 지워 재실행하지 않는다.

```sql
SELECT s.market_id, s.outcome, count(*) AS positions,
       sum(s.qty) AS settled_qty, sum(s.cost_basis_coin) AS cost_coin,
       sum(s.payout_coin) AS payout_coin, sum(s.settlement_pnl_coin) AS pnl_coin,
       coalesce(sum(e.amount_coin), 0) AS ledger_paid_coin
FROM position_settlements s
LEFT JOIN ledger_entries e ON e.id = s.ledger_entry_id
GROUP BY s.market_id, s.outcome
ORDER BY s.market_id, s.outcome;
```

```sql
SELECT m.id, coalesce(p.unsettled, 0) AS unsettled_positions,
       coalesce(p.qty, 0) AS qty, coalesce(p.cost, 0) AS cost_coin,
       coalesce(p.locked, 0) AS locked_qty,
       (ca.id IS NOT NULL AND cb.account_id IS NULL) AS collateral_balance_missing,
       coalesce(cb.available_coin, 0) AS collateral_available,
       coalesce(cb.locked_coin, 0) AS collateral_locked,
       coalesce(cb.ledger_coin, 0) AS collateral_ledger_copy,
       coalesce(l.coin, 0) AS collateral_ledger_actual,
       (fa.id IS NOT NULL AND fb.account_id IS NULL) AS funds_balance_missing,
       coalesce(fb.locked_coin, 0) AS funds_locked
FROM markets m
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE NOT settled) AS unsettled,
         sum(qty) AS qty, sum(cost_basis_coin) AS cost, sum(locked_qty) AS locked
  FROM positions WHERE market_id = m.id
) p ON true
LEFT JOIN ledger_accounts ca ON ca.kind = 'market_collateral' AND ca.market_id = m.id
LEFT JOIN balances cb ON cb.account_id = ca.id
LEFT JOIN LATERAL (
  SELECT sum(CASE WHEN to_account_id = ca.id THEN amount_coin ELSE -amount_coin END) AS coin
  FROM ledger_entries WHERE from_account_id = ca.id OR to_account_id = ca.id
) l ON true
LEFT JOIN ledger_accounts fa ON fa.kind = 'market_maker_funds' AND fa.market_id = m.id
LEFT JOIN balances fb ON fb.account_id = fa.id
WHERE m.status = 'settled'
ORDER BY m.id;
```

숫자 열은 모두 0, `*_missing`은 거짓이어야 한다. 이 SQL은 영구 기록과 지급 원장의 버전·키·손익 결합까지 대신 검사하지는 않는다. 그 최종 대사는 워커의 공통 정산 검사가 수행한다.

## 주문 접수 (#119, ADR-0112)

회원과 운영 마켓메이커의 주문은 한 처리가 받는다(`placeOrder`, `@buddha/db`). 접수는 출시 설정 주문 접수(`order.accepting`)가 참일 때만 열리고, 배포한 뒤에도 미정(닫힘)이다(ADR-0107 결정 3). 운영자가 할 일은 아래 넷이다.

- **배포한 뒤 넣는 값.** `/admin/settings`에서 주문 속도 제한(`order.rate_limit`, 시험값 20회/분)과 가격 보호 폭 표준값(`order.price_protection_ticks`, 시험값 5틱)을 사유와 함께 넣는다. 가격 보호 폭이 미정이면 시장을 검수 제출할 수 없고(개설 항목 '가격 보호 폭'), 속도 제한이 미정이면 계정 제한 없이 접속 주소 제한(1분 100회)만 걸린다. 값의 뜻은 [SETTINGS.md](SETTINGS.md).
- **주문 접수를 여는 때.** 정산의 대기 주문 확인(#126)과 완료된 #93이 운영에 배포된 뒤 오너가 `order.accepting`을 참으로 바꾼다. 그 전에는 미정으로 둔다 — 닫힌 동안 새 주문은 운영 마켓메이커의 것까지 주문 행 없이 거절되고(`ORDER_INTAKE_CLOSED`), 이미 걸린 주문과 그 잠금은 그대로 남는다 — 그 주인은 취소할 수 있고, 일시 중단·계정 제한 승인·탈퇴가 취소한다([주문 취소](#주문-취소-178-adr-0113)). 거짓으로 바꾸면 다시 닫힌다. 바꾼 값은 다음 주문부터다. 공개 호가와 견적(#179, ADR-0114)은 닫힌 동안에도 답한다 — 견적에 체결이 보여도 접수는 거절한다. 시장의 마감은 이 설정과 상관없이 남은 대기 주문을 만료한다([시장 마감과 주문 만료](#시장-마감과-주문-만료-120-adr-0115)). 닫힌 동안에는 새 사용자 체결이 생기지 않으므로 한 번도 연 적이 없는 지금은 #20 배포 뒤 마감하는 시장이 모두 취소(CANCELLED)가 된다. 연 동안 사람이 거래한 시장은 거짓으로 다시 닫은 뒤에 마감해도 그 체결이 남아 마감(CLOSED)으로 가 판정·정산을 거친다 — 판단은 설정이 아니라 그 시장의 체결 기록이다([거래 없는 시장의 취소](#거래-없는-시장의-취소-20-adr-0117)).
- **가격 보호 폭이 없는 시장.** #119 배포 전에 검수 제출한 시장은 폭이 비어 있을 수 있다(초안은 검수 제출 때 그때의 표준값을 넣으므로 상관없다). 아래 확인 (b)가 그 시장을 보인다. 거래 중·일시 중단 시장은 관리자 상세의 '가격 보호 폭 변경'(사유 필수, 관리자 한 명)으로 값을 넣는다 — 그 전까지 거래 중인 그 시장의 즉시 거래 주문과 그 견적(#179)은 `ORDER_INTAKE_CLOSED`로 거절되고 지정가는 받는다. 일시 중단·개장 예정 시장은 그 상태의 거절(일시 중단·개장 전)이, 거래 마감 시각이 지난 거래 중 시장은 '마감'이(#120, 워커가 마감하기 전) 폭보다 먼저라, 폭이 없어도 지정가까지 그 사유를 단 주문 행으로 거절되고 견적도 그 사유의 거절이다(409가 아니다). 검수 대기 시장은 승인이 거절하므로 초안으로 되돌려 다시 검수 제출하고, 개장 예정 시장은 되돌리거나 열린 뒤 바꾼다. 폭은 검수부터 DB가 잠가(`markets_price_protection_fixed`) SQL로 넣지 않는다.
- **운영 마켓메이커.** 같은 처리와 같은 규칙으로 주문한다(봇의 실행은 M10 #129). 속도 제한은 세지 않고(HTTP를 거치지 않는다), 주문 접수가 닫혀 있으면 봇의 주문도 거절된다. 봇의 잠금은 그 시장의 마켓메이커 자금에서 한다.

거래 중인 시장은 거래 마감 시각부터 워커가 시장을 마감하기 전이라도 새 주문이 '마감' 사유의 주문 행으로 거절되고(그 시장의 거래 마감 시각과 DB 시각만 본다, #120), 공개 호가·견적도 같은 사유로 비어 있다. 일시 중단·개장 예정 시장은 마감 시각이 지나도 그 상태의 사유('일시 중단'·'개장 전')가 먼저다. 거래 마감 시각 전에 받은 주문도 체결하는 순간에 다시 보아, 그 순간이 마감 시각을 지났으면 체결 없이 '마감'으로 거절한다.

주문과 체결은 지우지 않는다 — 서버가 시장·자산·호가 때문에 거절한 주문도 사유와 함께 남고(보존기간 없음), 주문 행은 어느 롤로도 지우지 못하며(`orders_keep_record`) 체결 행은 고치거나 지우지 못한다(`fills_keep_record`). 관리자는 권한이 있는 동안 주문할 수 없다(서버와 DB 트리거 `orders_refuse_admin_owner`).

**확인(읽기만).** [원장 계정](#원장-계정-116-adr-0109)과 같이 psql로 붙어 돌린다. (a)는 잠금이 걸린 주문의 합인지다: 원장 계정(사람의 사용자 계정, 시장마다의 마켓메이커 자금)마다 `locked_coin`이 걸린 수량 매수의 보호 한도 × (수량 − 체결)의 합과 같고, 보유마다 `locked_qty`가 걸린 매도의 (수량 − 체결)의 합과 같아야 한다. 줄이 없어야 한다 — 줄이 있으면 그 계정(`owner_id`, `market_id`)과 두 값(`locked`, `live`)을 오너에게 알린다(대사와 정정은 #93). (b)는 가격 보호 폭이 없는 검수 대기·개장 예정·거래 중·일시 중단 시장이다.

```sql
SELECT 'coin' AS lock, a.kind::text AS holder, a.owner_id, a.market_id,
       b.locked_coin::text AS locked,
       coalesce(sum(o.protected_limit_price::bigint * (o.qty - o.filled_qty)), 0)::text AS live
FROM ledger_accounts a
JOIN balances b ON b.account_id = a.id
LEFT JOIN orders o ON o.status IN ('open', 'partially_filled') AND o.side = 'buy'
  AND o.user_id = a.owner_id AND (a.kind = 'user' OR o.market_id = a.market_id)
WHERE a.kind IN ('user', 'market_maker_funds')
GROUP BY a.id, a.kind, a.owner_id, a.market_id, b.locked_coin
HAVING b.locked_coin <> coalesce(sum(o.protected_limit_price::bigint * (o.qty - o.filled_qty)), 0)
UNION ALL
SELECT 'contracts', p.outcome::text, p.user_id, p.market_id, p.locked_qty::text,
       coalesce(sum(o.qty - o.filled_qty), 0)::text
FROM positions p
LEFT JOIN orders o ON o.status IN ('open', 'partially_filled') AND o.side = 'sell'
  AND o.user_id = p.user_id AND o.market_id = p.market_id AND o.outcome = p.outcome
GROUP BY p.user_id, p.market_id, p.outcome, p.locked_qty
HAVING p.locked_qty <> coalesce(sum(o.qty - o.filled_qty), 0)
ORDER BY 1, 3, 4, 2;
```

```sql
SELECT id, status, title, created_at
FROM markets
WHERE price_protection_ticks IS NULL AND status IN ('review', 'scheduled', 'open', 'paused')
ORDER BY created_at;
```

## 주문 취소 (#178, ADR-0113)

대기·부분 체결 주문의 취소는 한 처리가 맡는다(`order-cancel.ts`, `@buddha/db`). 취소는 남은 수량 전부를 그 요청의 트랜잭션 안에서 '취소 완료'로 끝내고 남은 잠금(매수의 한도가격 × 남은 수량 Coin, 매도의 남은 계약)을 가용으로 푼다. 체결 수량·금액은 그대로이고 원장 이벤트·체결·시장가격은 생기지 않는다. 정정과 일부 취소는 없고, 서버에 '취소 요청 중' 상태도 없다(화면의 상태, #123). 운영자가 할 일은 없다 — 아래는 어느 흐름이 어떤 사유로 취소하는지와 읽기만 하는 확인이다.

- **본인 취소.** 회원이 `POST /me/orders/:id/cancel`로 자기 주문을 취소한다(사유 '본인 취소'). 주문 속도 제한에 세지 않고, 주문 접수가 닫혀 있어도, 계정 제한 중에도 된다. 이미 끝난 주문은 그대로 답하고, 다른 계정의 주문은 없는 주문과 같이 답한다.
- **일시 중단.** 관리자가 시장을 멈추는 트랜잭션이 그 시장의 회원과 운영 마켓메이커의 대기 주문을 모두 취소한다(사유 '일시 중단'). 재개를 승인하는 트랜잭션도 상태를 바꾸기 전에 남은 대기 주문을 같은 사유로 끝내고, 조기 마감의 승인은 마감한 뒤 같은 순간에 남은 주문을 '만료'로 끝낸다(#120 — 멈출 때 모두 취소했으므로 보통 남은 주문이 없다).
- **담보·원장 장애로 멈춘 시장.** 이 시장은 복구할 때까지 주문의 잠금과 원장을 쓰지 않는다. 멈출 때 대기 주문은 잠금을 둔 채 남고, 회원의 본인 취소는 거절된다(`MARKET_NOT_OPEN`). 재개나 조기 마감의 승인이 복구이고, 그 트랜잭션이 대기 주문을 '취소 완료(일시 중단)'로 끝낸다. 복구 전에 마감 시각이 오면 시장은 예정대로 마감하고(사람 계정이 낀 체결이 없으면 취소 — [거래 없는 시장의 취소](#거래-없는-시장의-취소-20-adr-0117)) 대기 주문은 잠금과 함께 남는다 — 그 주문은 [대사와 보류 복구](#대사와-보류-복구-93-adr-0119)의 승인 트랜잭션이 '만료'로 끝낸다. 확인 (d)가 복구를 기다리는 주문을 보인다.
- **계정 제한.** 계정 제한(적용)을 승인하는 트랜잭션이 그 계정의 모든 시장의 대기 주문을 취소한다(사유 '계정 제한'). 제한이 끝나거나 풀려도 되살리지 않는다. 담보·원장 장애로 멈춘 시장의 주문은 건너뛰고 복구 때 끝난다 — 제한은 그대로 곧바로 걸린다.
- **탈퇴.** 탈퇴하는 트랜잭션이 회원의 대기 주문을 취소하고(사유 '탈퇴', 기록·운영 화면에만 보인다) 풀린 잠금까지 탈퇴 소멸로 처리한다. 담보·원장 장애로 멈춘 시장에 복구를 기다리는 주문이 있으면 탈퇴를 거절한다(`orders_awaiting_recovery`).
- **관리자 권한.** 권한 부여와 시드 승격은 같은 트랜잭션에서 대기 주문을 취소한다(사유 '관리자 권한', #143·ADR-0120). 원장 장애로 묶인 시장의 주문·잠금은 복구까지 보류하고 보유 계약은 남긴다. 부여 전 영향과 실제 취소·보류 수는 운영자 계정 화면에서 확인한다.

**확인(읽기만).** [원장 계정](#원장-계정-116-adr-0109)과 같이 psql로 붙어 돌린다. 잠금이 걸린 주문의 합인지는 [주문 접수](#주문-접수-119-adr-0112)의 확인 (a)가 본다. (a)는 거래 중이 아닌 시장에 남은 대기 주문이다(담보·원장 장애로 묶인 시장은 빼고). 마감이 남은 대기 주문을 만료하므로(#120) 줄이 없어야 한다 — 마감한 시장의 줄은 #120 배포 전에 마감한 시장의 남은 주문(그 주인이 취소할 수 있다)이다. #120 배포 뒤에 마감한 시장의 줄이면 어느 길이 만료 없이 시장을 마감한 것이니 오너에게 알린다. 실패한 마감은 트랜잭션 전체가 되돌아가 시장이 거래 중으로 남으므로 여기 보이지 않는다([시장 마감과 주문 만료](#시장-마감과-주문-만료-120-adr-0115)의 '마감이 매 분 실패할 때'). (b)는 탈퇴한 계정의 대기 주문, (c)는 계정 제한이 걸린 계정의 대기 주문(담보·원장 장애로 묶인 시장은 빼고)이고, 둘 다 줄이 없어야 한다. 줄이 있으면 그 주문과 시장을 오너에게 알린다. (d)는 새 활성 보류 또는 복구되지 않은 옛 원장 중단에 묶여 복구를 기다리는 대기 주문과 잠금이다. 활성 보류 id·실패 근거와 옛 중단을 함께 보이며, 새 보류만 있으면 중단 열은 NULL일 수 있다. (a)·(c)·(d)와 아래 취소 시장 확인은 모두 새 활성 보류와 옛 중단의 복구 연결을 같은 기준으로 읽는다. 이 네 SELECT도 2026-11-09에 전용 `buddha_m93_test`/5433의 읽기 전용 실행과 새 보류·옛 중단·복구 완료의 CTE 사례로 확인했다.

```sql
SELECT o.id, o.user_id, o.market_id, m.status AS market_status, o.status, o.created_at
FROM orders o
JOIN markets m ON m.id = o.market_id
WHERE o.status IN ('open', 'partially_filled') AND m.status <> 'open'
  AND NOT (
    EXISTS (
      SELECT 1 FROM reconciliation_holds h
      WHERE h.market_id = o.market_id AND h.recovered_at IS NULL)
    OR EXISTS (
      SELECT 1 FROM market_pauses p
      WHERE p.market_id = o.market_id AND p.reason = 'ledger_failure'
        AND (p.ended_at IS NULL OR p.end_kind = 'closed_at_close')
        AND NOT EXISTS (
          SELECT 1 FROM reconciliation_recoveries r WHERE r.legacy_pause_id = p.id)))
ORDER BY m.status, o.market_id, o.arrival_seq;
```

```sql
SELECT o.id, o.user_id, o.market_id, o.status, o.created_at
FROM orders o
JOIN profiles pr ON pr.user_id = o.user_id
WHERE o.status IN ('open', 'partially_filled') AND pr.nickname IS NULL
ORDER BY o.user_id, o.arrival_seq;
```

```sql
SELECT o.id, o.user_id, o.market_id, o.status, o.created_at
FROM orders o
WHERE o.status IN ('open', 'partially_filled')
  AND EXISTS (
    SELECT 1 FROM moderation_actions a
    WHERE a.user_id = o.user_id AND a.type = 'account_restriction' AND a.cancelled_at IS NULL
      AND (a.ends_at IS NULL OR a.ends_at > clock_timestamp()))
  AND NOT (
    EXISTS (
      SELECT 1 FROM reconciliation_holds h
      WHERE h.market_id = o.market_id AND h.recovered_at IS NULL)
    OR EXISTS (
      SELECT 1 FROM market_pauses p
      WHERE p.market_id = o.market_id AND p.reason = 'ledger_failure'
        AND (p.ended_at IS NULL OR p.end_kind = 'closed_at_close')
        AND NOT EXISTS (
          SELECT 1 FROM reconciliation_recoveries r WHERE r.legacy_pause_id = p.id)))
ORDER BY o.user_id, o.arrival_seq;
```

```sql
SELECT o.market_id, m.status AS market_status, h.id AS hold_id,
       h.failure_result_id, p.id AS pause_id, p.paused_at, p.end_kind,
       o.id AS order_id, o.user_id, o.side, o.outcome, o.status,
       o.qty - o.filled_qty AS remaining_qty,
       CASE WHEN o.side = 'buy' THEN o.protected_limit_price::bigint * (o.qty - o.filled_qty)
            ELSE 0 END AS locked_coin
FROM orders o
JOIN markets m ON m.id = o.market_id
LEFT JOIN reconciliation_holds h ON h.market_id = o.market_id AND h.recovered_at IS NULL
LEFT JOIN LATERAL (
  SELECT p.id, p.paused_at, p.end_kind
  FROM market_pauses p
  WHERE p.market_id = o.market_id AND p.reason = 'ledger_failure'
    AND (p.ended_at IS NULL OR p.end_kind = 'closed_at_close')
    AND NOT EXISTS (
      SELECT 1 FROM reconciliation_recoveries r WHERE r.legacy_pause_id = p.id)
  ORDER BY p.paused_at DESC, p.id DESC LIMIT 1
) p ON true
WHERE o.status IN ('open', 'partially_filled')
  AND (h.id IS NOT NULL OR p.id IS NOT NULL)
ORDER BY o.market_id, o.arrival_seq;
```

## 개장 전 유동성 설정 (#72, ADR-0122)

`/admin/settings`의 유동성 표준값 여섯 항목은 처음에 모두 미정이다. 관리자 시장 상세에서 아직 저장된 유동성 설정이 없는 초안의 폼을 열면 명시된 값과 설계 제안·시험값·승인됨 상태를 제안한다. 비어 있는 값은 직접 입력한다. 조회 실패 시 다시 조회하거나 표준값 없이 직접 입력할 수 있다. 화면 조회만으로는 시장이나 버전을 저장하지 않으며, 이미 저장한 시장과 작성 중인 폼에는 변경된 표준값을 소급하지 않는다. 시험값은 운영 승인 수치가 아니다.

관리자 시장 상세의 유동성 설정에서 A·L·b·호가 단계·방향별 기본 물량·안전 간격을 입력하고 사유와 함께 저장한다. L은 A 이하여야 한다. 현재 설정·개장 버전·버전별 작업자와 시각·사유를 같은 화면에서 확인한다. 직접 LMSR의 참고 손실식이 봇 손실을 보장하지 않으며, 수치는 #71의 검증과 #133의 출시 결정으로 정한다.

설정이 없으면 검수 제출과 승인이 거절된다. 설정을 입력하거나 수정한 관리자는 해당 시장의 검수를 승인할 수 없다. 검수 중이나 개장 예정 시장을 고치려면 먼저 초안으로 되돌리고 다시 검수한다. 실제 개장 때 사용한 버전은 고정되고, 개장 뒤의 변경은 #130의 별도 통제를 따른다. 낡은 화면의 저장이 거절되면 최신 버전을 읽고 변경 내용을 다시 검토한다.

기존 데이터에 설정을 자동으로 채우지 않는다. 설정이 없는 예약 시장은 개장하지 않으므로 관리자 상세에서 확인하고 초안으로 되돌려 명시한 설정과 검수를 거친다. 이미 열린 시장을 이 PR이 멈추거나 다시 열지는 않는다. 설정 저장은 Coin 이동·금고 배정·봇 주문 실행을 하지 않으며, 실제 배정과 호가 실행은 #129에서 연결한다. 공개 API에는 설정이나 봇 참여 여부가 표시되지 않는다.

## 금고 발행과 마켓메이커 실행 확인 (#129)

관리자 메뉴의 **금고**(`/admin/treasury`)에서 가용·잠금·원장 Coin과 누적 발행액을 확인한다. 첫 발행 전 금고 계정이 없는 상태는 ‘금고 준비 전’으로, 장부가 맞지 않는 상태는 ‘금고 잔고 확인 필요’로 구분한다. 읽지 못한 잔액을 0으로 표시하지 않는다. 금고가 정상이어도 개장 때 필요한 A보다 가용 Coin이 적으면 ‘부족’이며, 불일치와 다른 상태다. 불일치는 [대사와 보류 복구](#대사와-보류-복구-93-adr-0119)에서 확인한다.

발행 요청에 금액과 사유를 적으면 그 내용이 고정된다. 요청자와 **다른 현재 관리자**가 사유를 남겨 승인하거나 반려하고, 요청자는 대기 요청을 철회할 수 있다. 승인 화면에서 금액을 고칠 수 없고 승인 한 번에 발행 한 번만 기록한다. 대기·처리 요청과 실제 발행 완료 이력은 구분한다. 누적 발행액에 포함된 과거 원장 행에서 승인 이력을 추측해 만들지 않는다. 운영 금고는 회원에게 재량 Coin을 주는 수단이 아니다.

관리자 시장 상세의 **운영 마켓메이커 실행**에서 현재·개장·마지막 적용 설정 버전, 현재 실행 조건, 갱신 대기와 마지막 실행 시도·성공·실패를 확인한다. 마지막 개장 처리의 필요 Coin·금고 가용 Coin은 **그 시도 당시의 관측**이다. 과거 개장 성공이나 현재 준비 조건 충족만으로 지금 호가가 게시 중이거나 금전 대사를 통과했다고 판단하지 않는다. 실행 오류는 간결한 안내로 보이며 내부 SQL·원문 오류를 화면에 표시하지 않는다.

개장에는 검수 승인, 시장별 유동성 설정, 유효한 전역 위험 단계 설정과 실제 A 배정이 필요하다. 금고가 없거나 부족해 배정하지 못하면 개장 예정에 남고 관리자 상세에 원인을 보인다. 자금을 새로 발행할지는 위의 별도 2인 승인으로 결정하며 개장 처리가 자동 발행하지 않는다. 실제 배정과 함께 시장별 자금 계정·실행 상태가 준비된다. 이미 거래 중인 시장에 설정·자금을 소급해서 채우지 않는다.

단계 세 값의 미정·잘못된 조합은 봇 호가 실행을 막으며 운영 숫자는 아직 확정되지 않았다([위험 단계 설정](SETTINGS.md#마켓메이커-위험-단계-설정-129)). `order.accepting`과 시장 중단·원장 보류도 그대로 따른다. 봇 상태와 시장 전체 거래 상태는 구분한다. **3회 시도 소진 뒤 해당 봇만 자동 정지한다**(오너 승인 2026-11-11). 정상 대기는 실패가 아니며 사람 거래는 유지한다. 안전한 봇 주문 취소는 별도로 진행하고, 원장 보류 등으로 취소하지 못한 잠금은 보존한다. 분당 스캔은 남은 정리만 다시 시도하며 자동 재개하지 않는다. 원인 해결 후 재개에는 #130의 다른 관리자 승인이 필요하다. 이 화면은 실행 상태 조회까지이며, 관리자 정지·재개·증액·설정 변경 통제는 후속 #130, 상세 지표는 #182에서 구현한다. 설정·재고·자금·실행 원인과 이력은 관리자 전용이며 공개 API·SSR·실시간 이벤트에 추가하지 않는다.

## 시장 마감과 주문 만료 (#120, ADR-0115)

거래 마감 시각에 워커가 시장을 마감한다(`market.close` — 승인 때 예약한 지연 잡, 그것을 잃으면 매 분 스캔). 거래 중과 거래 일시 중단인 시장이 예정대로, 늦추지 않고 마감한다. 마감하는 트랜잭션이 그 시장의 남은 대기 주문을 계정 유형과 상관없이(회원과 운영 마켓메이커) 모두 '만료'로 끝낸다. 운영자가 할 일은 없다 — 아래는 알아 둘 것과 실패했을 때 볼 곳이다.

- **만료가 하는 일.** 체결된 수량·금액은 그대로 두고 남은 수량만 끝내며, 남은 잠금(매수의 Coin, 매도의 계약, 운영 마켓메이커는 그 시장의 마켓메이커 자금)을 가용으로 한 번 푼다. 원장 이벤트·체결·시장가격은 생기지 않고 보유(`positions`의 수량)는 마감 때의 것으로 정해진다 — 마감한 시장에서는 정산(#126) 말고 어떤 계약도 움직이지 않는다. 만료는 취소 사유가 아니라 상태라 사유가 없다. 커밋 뒤 시장 방에 상태 신호(`market:status`)와, 만료한 주문이 있으면 호가 신호(`market:book`)를 한 번 낸다. 만료 알림은 #134다.
- **거래 마감 시각과 워커 사이.** 거래 중인 시장은 거래 마감 시각이 지나면 워커가 오기 전이라도 새 주문이 '마감'으로 거절되고 체결도 없다([주문 접수](#주문-접수-119-adr-0112)). 일시 중단·개장 예정 시장은 그 상태의 사유('일시 중단'·'개장 전')가 먼저다. 그 사이 회원은 자기 대기 주문을 취소할 수 있다(본인 취소) — 마감이 오면 남은 것은 만료된다.
- **조기 마감.** 관리자의 거래 일시 중단(PAUSED) 뒤 다른 관리자가 승인한 조기 마감도 같은 마감이다: 원장 장애로 묶이지 않은 시장은 마감한 같은 순간에 남은 주문을 만료로 끝낸다(멈출 때 모두 취소했으므로 보통 없다). 원장 장애로 멈춘 시장의 조기 마감 승인은 복구를 겸해 먼저 '취소 완료(일시 중단)'로 끝낸다([주문 취소](#주문-취소-178-adr-0113)). 마감한 시장은 다시 거래 중으로 돌아가지 않는다.
- **원장 장애로 묶인 시장.** 복구 전에 거래 마감 시각이 오면 시장은 예정대로 마감하고(사람 계정이 낀 체결이 없으면 취소 — 아래 줄, 어느 쪽이든 일시 중단 기록은 '예정 마감') 대기 주문은 잠금과 함께 남는다. 그 주문을 만료로 끝내는 절차는 [대사와 보류 복구](#대사와-보류-복구-93-adr-0119)다. 잔고 행이 빠진 장애에서도 상태 마감은 진행하고 자산 잠금은 복구까지 보존한다. [주문 취소](#주문-취소-178-adr-0113)의 확인 (d)가 그 주문을 보인다.
- **거래가 전혀 없던 시장.** 사람 계정이 낀 체결이 한 건도 없는 시장은 마감 대신 같은 트랜잭션에서 취소(CANCELLED)로 간다 — 남은 주문의 만료는 같다([거래 없는 시장의 취소](#거래-없는-시장의-취소-20-adr-0117)).
- **마감이 매 분 실패할 때.** 잠금이 주문이 가리키는 것을 쥐고 있지 않으면 보류가 없는 시장의 마감 트랜잭션은 되돌아간다. 시장은 상태로 거래 중이어도 거래 마감 시각이 지나 주문·체결은 거절된다. [주문 접수](#주문-접수-119-adr-0112)의 확인 (a)와 [계약과 담보](#계약과-담보-118-adr-0110)를 읽고 오너에게 알린다. [대사와 보류 복구](#대사와-보류-복구-93-adr-0119)의 수동 시장 검사는 거래 마감 시각이 지난 OPEN도 불일치 시 자동 중단할 수 있다. 이후 예정 마감은 주문과 잠금을 보존한 채 CLOSED 또는 CANCELLED로 전이한다. 일반 관리자의 과거 시각 중단 요청을 허용한 것은 아니며, 원인 해결과 최신 통과·다른 관리자의 복구 승인이 남는다. SQL로 주문·잠금·잔고를 덮어쓰지 않는다. Coin 보정으로 해결할 수 있는 차이만 전용 요청·승인으로 처리하며, 주문·잠금 손상은 보정 후보가 아니다.

## 거래 없는 시장의 취소 (#20, ADR-0117)

시장은 세 길로 취소(CANCELLED, 라벨 '취소')된다. 취소한 시장은 결과 유형이 비어 있고(무효가 아니다) 판정 등록·판정 이의·지급이 생기지 않으며, 다시 열거나 마감으로 돌아가지 않는다. 공개 상세는 남고(개장 예정에서 취소한 시장도), 홈에는 보이지 않으며, 검색은 '취소'로 거르고, 관련 시장에서 빠지고, 토론과 관심 등록은 그대로 받는다. 사유는 시장 사건(`cancelled`)에 남고, 공개 판정 기록에 취소 시각과 함께 보인다(#24, ADR-0121). 운영자 취소의 공개 사유와 내부 승인 사유는 구분하며 내부 승인 사유·관리자 신원은 공개하지 않는다.

- **거래 마감 시각.** 워커의 마감(`market.close`, 지연 잡과 매 분 스캔)이 거래 중·일시 중단 시장에서 사람 계정이 낀 체결을 하나도 찾지 못하면 마감 대신 취소로 보낸다. 판단은 마감과 같은 트랜잭션에서 시장 잠금 아래 체결 기록(`fills`에 복사한 두 계정 유형)으로 한다 — 참여자 수(`trader_count`)가 아니고, 비정상 표시(#132)와 상관없다. 운영 마켓메이커의 주문만 있던 시장, 걸리기만 하고 체결되지 않은 주문만 있던 시장, 봇의 쌍 준비만 있던 시장은 거래가 없던 시장이다. 쌍 발행은 체결 한 건이다. 사건의 행위자는 없고(시스템), 사유는 시스템 문장 '거래가 끝날 때까지 체결이 한 건도 없어 결과를 정하지 않고 시장을 취소했습니다.'이다.
- **조기 마감.** 일시 중단 시장의 조기 마감을 다른 관리자가 승인하는 트랜잭션도 같은 판단을 한다 — 사람이 낀 체결이 없으면 일시 중단 → 취소다(행위자는 승인한 관리자, 같은 시스템 문장, 검토 결과는 사건에 남는다). 일시 중단 기록은 그대로 '조기 마감'으로 끝난다 — 끝난 방식은 일시 중단이 어떻게 끝났는지이고, 시장이 어디로 갔는지는 사건이 말한다. 승인 창이 그렇게 된다고 미리 말한다.
- **남은 주문.** 취소하는 트랜잭션이 남은 대기 주문을 회원과 운영 마켓메이커의 것 모두 '만료'로 끝내고 잠금을 한 번 푼다(마감과 같은 처리, [시장 마감과 주문 만료](#시장-마감과-주문-만료-120-adr-0115)). 원장 장애로 묶인 시장은 취소되어도 주문을 잠근 채 두고 [대사와 보류 복구](#대사와-보류-복구-93-adr-0119)의 승인이 만료로 끝낸다 — [주문 취소](#주문-취소-178-adr-0113)의 확인 (d)가 그 주문을 보인다. 원장 장애로 멈춘 시장의 조기 마감 승인은 복구를 겸하므로 '취소 완료(일시 중단)'가 먼저다. 그 밖에 Coin은 움직이지 않는다 — 원장 이벤트·지급·보유·담보가 그대로이고, 취소한 시장의 마켓메이커 자금 회수는 #181이다.
- **개장 예정 시장의 취소(운영자).** 결과가 알려지는 등 개장 예정(SCHEDULED) 시장을 열지 않고 끝내려면 관리자 상세의 '시장 취소' 칸에서 '시장 취소 요청'을 누르고 취소 사유를 쓴다. 이 사유가 공개 판정 기록에 실릴 취소 사유다. 요청하지 않은 다른 관리자가 그 시장의 상세에서 사유와 함께 승인하면 그때 개장 예정 → 취소가 되고, 예약한 개장·마감 잡이 지워진다. 기다리는 요청은 검수 대기 화면의 '시장 취소 대기'에 오래된 것부터 보인다. 한 시장에 기다리는 요청은 하나이고, 요청한 관리자는 승인·반려하지 못하고 철회만 하며, 다른 관리자가 없으면 요청이 거절된다(`no_decider`). 기다리는 요청은 예정 개장을 붙잡지 않는다 — 그 전에 시장이 열리면 승인이 거절되고 반려나 철회로 끝낸다. 그때 끝내려면 일시 중단 뒤 조기 마감을 요청한다(체결이 없으면 위대로 취소된다). 요청한 뒤 초안으로 되돌렸다가 다시 승인한 시장은 옛 요청을 승인할 수 없다 — 반려나 철회로 끝내고 다시 요청한다. 거래 중·일시 중단·마감한 시장을 운영자가 바로 취소하는 길은 없다.
- **배포가 운영 데이터에 하는 일(#20 배포, 오너를 기다리는 머지).** 배포한 뒤부터 거래 마감 시각에 이르거나 다른 관리자가 조기 마감을 승인한 운영 시장 가운데 사람이 낀 체결이 없는 것은 모두 취소된다 — 배포 전에 요청해 기다리던 조기 마감도 승인되면 검토 결과와 상관없이 판정 없이 취소된다. 주문 접수(`order.accepting`)를 한 번도 연 적이 없는 동안(지금의 운영)에는 사람의 체결이 없으므로 마감하는 운영 시장이 모두 취소된다 — 연 뒤에는 그 시장의 체결 기록이 정한다([주문 접수](#주문-접수-119-adr-0112)). 배포 때 이미 거래 마감 시각이 지났는데 아직 거래 중·일시 중단인 시장(워커가 밀렸을 때)도 배포 뒤 첫 스캔이 취소한다. 배포 전에 이미 마감(CLOSED)한 시장은 쓸지 않는다 — 마감 → 취소 전이가 없고 그런 시장을 보는 잡도 없어 그대로 마감으로 남아 판정으로 간다. Coin은 움직이지 않는다 — 원장 이벤트·지급·보유·담보가 그대로다. 취소는 되돌릴 수 없다. 마이그레이션과 행을 고치는 쓰기는 없다.

**확인(읽기만).** [원장 계정](#원장-계정-116-adr-0109)과 같이 psql로 붙어 돌린다. 둘 다 줄이 없어야 한다. (a)는 사람이 낀 체결이 있는데 취소된 시장이고, (b)는 원장 장애로 묶이지 않았는데 대기 주문이 남은 취소 시장이다. 줄이 있으면 고치지 말고 그 시장과 줄을 오너에게 알린다. DB는 커밋 때 이것을 따로 검사하지 않는다 — 시장 잠금 아래의 판단과 시험이 지킨다([GUARDS.md](GUARDS.md)).

```sql
SELECT m.id AS market_id, count(f.id)::int AS human_fills
FROM markets m
JOIN fills f ON f.market_id = m.id
  AND (is_human_account_type(f.incoming_account_type)
       OR is_human_account_type(f.resting_account_type))
WHERE m.status = 'cancelled'
GROUP BY m.id
ORDER BY m.id;
```

```sql
SELECT o.market_id, o.id AS order_id, o.user_id, o.status
FROM orders o
JOIN markets m ON m.id = o.market_id
WHERE m.status = 'cancelled' AND o.status IN ('open', 'partially_filled')
  AND NOT (
    EXISTS (
      SELECT 1 FROM reconciliation_holds h
      WHERE h.market_id = o.market_id AND h.recovered_at IS NULL)
    OR EXISTS (
      SELECT 1 FROM market_pauses p
      WHERE p.market_id = o.market_id AND p.reason = 'ledger_failure'
        AND (p.ended_at IS NULL OR p.end_kind = 'closed_at_close')
        AND NOT EXISTS (
          SELECT 1 FROM reconciliation_recoveries r WHERE r.legacy_pause_id = p.id)))
ORDER BY o.market_id, o.arrival_seq;
```

## 시장 통계 (#121, ADR-0116)

시장의 시장가격(마지막 체결의 YES 기준 값, `markets.last_price`)과 그 갱신시각(`last_fill_at`), 누적 거래량(`volume_coin`), 체결 수(`trade_count`), 참여자 수(`trader_count`)는 체결이 있었던 주문 접수가 그 체결과 같은 트랜잭션에서 시장 잠금 아래 한 번 쓴다(`@buddha/db` market-stats.ts). 개장·거래 일시 중단·마감과 주문 만료·취소·판정·정산·시드는 이 값을 쓰지 않는다. 운영자가 고칠 값은 없다.

- **값의 뜻.** 시장가격은 마지막 체결(서버 시각, 같은 시각이면 체결 번호가 큰 것)의 YES 기준 값이다 — NO 37의 체결은 63, 쌍 발행은 체결 하나이고 100 − NO 가격이다. 첫 체결 전에는 둘 다 비어 있다('체결 없음', 개장의 50%는 가격이 아니다). 거래량은 체결마다 들어온 주문의 계약 가격 × 수량을 한 번 더한 것이라 공개 최근 체결의 금액을 모두 더한 값과 같다. 참여자는 그 시장에서 체결이 한 건이라도 있는 사람 계정(계정 유형 규칙, 운영 마켓메이커는 빠지고 관리자는 든다)의 수로, 전량 매도나 탈퇴로 줄지 않는다 — 판정 이의 자격(`hasMarketFill`)과 같은 기준이다.
- **가격 기록.** 차트와 최근 체결은 체결 행(`fills`)을 그대로 읽는다. 체결 행은 바뀌거나 지워지지 않으므로 위의 값은 언제든 체결에서 다시 셀 수 있다. 옛 AMM의 `price_ticks`는 그대로 두고 아무것도 읽거나 쓰지 않는다.
- **확인.** 아래 SQL은 읽기만 하며, 행이 없으면 모든 시장의 통계가 그 체결과 같다. 행이 나오면 고치지 말고 오너에게 알린다(이번 #93 구현분은 통계 재계산·정정을 하지 않으며, 이상 체결을 빼는 다시 세기는 #132).
- **배포 때.** 마이그레이션 0063은 체결이 하나라도 있거나 통계가 기본값이 아닌 시장이 있는 DB에서 아무것도 하지 않고 멈춘다(다시 세기는 UPDATE라 오너의 결정이다). 운영 DB는 0060이 비웠고 주문 접수가 닫혀 있어 지나간다. 로컬 개발 DB가 멈추면 [RESET.md](RESET.md)대로 비운다.

```sql
WITH totals AS (
  SELECT market_id, sum(amount_coin) AS volume, count(*)::int AS trades
  FROM fills GROUP BY market_id
), last AS (
  SELECT DISTINCT ON (market_id) market_id, yes_price_coin, created_at
  FROM fills ORDER BY market_id, created_at DESC, id DESC
), people AS (
  SELECT market_id, count(DISTINCT owner_id)::int AS traders
  FROM (SELECT market_id, incoming_owner_id AS owner_id FROM fills
        WHERE is_human_account_type(incoming_account_type)
        UNION ALL
        SELECT market_id, resting_owner_id FROM fills
        WHERE is_human_account_type(resting_account_type)) AS sides
  GROUP BY market_id
)
SELECT m.id AS market_id,
       m.last_price, l.yes_price_coin AS fills_last_price,
       m.last_fill_at, l.created_at AS fills_last_fill_at,
       m.volume_coin::text AS volume_coin, coalesce(t.volume, 0)::text AS fills_volume_coin,
       m.trade_count, coalesce(t.trades, 0) AS fills_trade_count,
       m.trader_count, coalesce(p.traders, 0) AS fills_trader_count
FROM markets m
LEFT JOIN totals t ON t.market_id = m.id
LEFT JOIN last l ON l.market_id = m.id
LEFT JOIN people p ON p.market_id = m.id
WHERE m.last_price IS DISTINCT FROM l.yes_price_coin
   OR m.last_fill_at IS DISTINCT FROM l.created_at
   OR m.volume_coin <> coalesce(t.volume, 0)
   OR m.trade_count <> coalesce(t.trades, 0)
   OR m.trader_count <> coalesce(p.traders, 0)
ORDER BY m.id;
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

## 관리자 권한과 이해관계 (#143, ADR-0120)

관리자는 담당 시장 구분 없이 모든 시장에서 주문할 수 없다. 시장별 판정 담당자를 배정하지 않으며, 판정·정정·이의 처리의 자격은 실제 체결 이력과 영구 신고로 판단한다. 새로운 출시 설정이나 운영 호스트 명령은 없다.

**이해관계의 범위.** ADR-0107 결정 4의 네 범주다.

1. 그 시장에 체결 이력이 있음. 전량 매도·정산으로 현재 보유가 0이어도 자동으로 배제한다.
2. 본인이나 가족이 사건의 당사자이거나 결과로 직접 이익·손해를 봄.
3. 판정 출처 기관에 속하거나 그 발표에 관여함.
4. 그 밖에 공정성을 의심받을 관계.

**신고.** 관리자 시장 상세의 이해관계 영역에서 본인이 사유 1~500자를 적는다. 다른 사람을 대신 지정하지 않는다. 승인 없이 바로 효력이 있고 사유 수정·철회는 없다. 체결로 이미 자동 배제된 사람도 추가 사유를 신고할 수 있다. 최초 신고는 본인이 그 시장에 등록해 기다리는 판정·정정을 같은 트랜잭션에서 철회한다. 정정에 연결된 인용 이의는 검토 중으로 돌아간다. 신고나 철회 중 하나라도 실패하면 모두 되돌린다. 중복 전송은 최초 사유를 유지한다. 신고 사유·신원·이력은 관리자 전용이고 공개 판정 기록에 싣지 않는다.

**판정·정정·이의.** 등록·승인과 이의 기각·인용마다 '이 시장에 신고할 이해관계가 없다'를 확인한다. 확인란을 체크해도 실제 체결/신고 이력이 있으면 거절한다. 판정·정정 등록에는 이해관계가 없는 다른 관리자가 있어야 하고, 승인 때 등록자와 승인자를 모두 다시 확인한다. 기존의 자기 승인 금지와 판정 등록자·이의 제출자의 이의 처리 금지도 유지한다. 반려·철회는 대기를 정리할 수 있도록 남긴다. 적격 관리자가 없으면 새 관리자를 부여하고 판정 지연 절차를 따른다. 신고가 이미 승인된 결과나 지급을 자동으로 바꾸지는 않는다. 잠정 결과 중 드러난 이해관계는 지급 전 정정, 확정 뒤에는 #144의 처리 대상이다.

**부여.** `/admin/admins`에서 대상의 체결 시장 수·대기 주문 수·취소 보류 수를 읽고 사유를 적는다. 이 숫자는 조회 당시의 값이고 서버는 부여 트랜잭션에서 다시 계산한다. 체결 이력이 있어도 부여할 수 있다. 보류되지 않은 대기 주문은 '관리자 권한'으로 취소하고 잠금을 돌려주며, 원장 장애 시장의 주문과 잠금은 #93 복구까지 그대로 둔다. 계약 보유는 남고 정산 지급도 유지한다. 실제 취소·보류 수는 응답과 변경 기록에 남는다. 경합으로 409 `TRANSACTION_BUSY`를 받으면 잠시 뒤 부여를 다시 시도한다. 실패한 시도의 권한·취소·감사 기록이 일부만 남지 않는다. 계정 제한 승인에서 같은 오류가 나도 승인 전체를 다시 시도한다.

**회수.** 기존 최소 관리자 2명과 모든 세션 삭제 규칙은 그대로다. 다시 로그인한 회원은 마지막 권한 회수 시각보다 엄격히 뒤에 생성된 시장에서만 새 주문을 낼 수 있다. 회수 전 초안이 나중에 열려도 기존 시장이고 같은 밀리초의 생성도 허용하지 않는다. 이름 변경·개장·재개는 생성 경계를 바꾸지 않는다. 기존 보유·본인 취소·정산 지급은 유지한다. 공개 호가·견적은 개인의 회수 이력을 보지 않으므로 견적이 보여도 주문이 `admin_role_revoked` 사유로 거절될 수 있다.

**배포와 기록.** 0066은 신고 표·회수 조회 인덱스·주문 사유와 방어를 더하며 기존 행을 비우거나 채우지 않는다. 이미 저장된 체결과 회수 이력은 배포 뒤 새 판단부터 적용한다. 기존 관리자의 주문을 배포 때 일괄 취소하지 않고 이후 권한 부여에서 취소한다. 이해관계 있는 기존 대기 판정도 일괄 철회하지 않지만 이후 승인은 거절하며, 본인 신고가 대기 요청을 함께 철회한다. 관리자 변경 기록의 옛 행에는 새 취소/보류 수가 없을 수 있다. 신고는 보존기간 작업이나 역할 회수·탈퇴로 지우지 않는 영구 기록이며, 별도 승인 없이 초기화를 신고 철회 수단으로 쓰지 않는다.

## 판정 이의 처리 (#175, ADR-0104)

회원은 시장의 잠정 결과에 앱 안에서 판정 이의를 낸다 — 받은 조치에 대한 제재 이의(아래, 이메일)와 다른 것이다. 그 시장에 체결 이력이 있는 회원만, 이의 기한(판정을 승인할 때 출시 설정 `market.dispute_window`로 고정한 시각 — 판정을 정정하면 새 기한, 아래 '판정 정정') 전에, 판정 버전마다 한 번, 근거 링크(1\~5개)와 사유로 낸다(ADR-0093 결정 1 #173 6항). 처리는 화면에서 한다: 관리자 메뉴 '이의 접수'(검토 대기·처리됨)에서 찾고, 그 시장의 관리자 상세 판정 칸의 '판정 이의'에서 사유와 함께 기각하거나 수용한다. 주문 접수(`order.accepting`)가 열리기 전에는 배포 환경에 체결이 없어 낼 수 있는 회원이 없다(#119가 닫힌 채 등록했고 오너가 #126·#93 뒤에 연다, 위 '주문 접수').

- **누가.** 그 판정 버전을 등록한 관리자가 아닌 관리자 한 명이다(#173 2항 — 승인한 관리자도 된다). 그 이의를 낸 계정도 처리하지 않는다 — 관리자는 이의를 내지 못하지만, 이의를 낸 뒤 관리자 역할을 받은 회원이면 자기 이의를 처리하지 못한다. 2인 통제의 요청이 아니다. 기각은 되돌리지 않고, 수용은 그 이의와 함께 등록한 정정이 반려되거나 철회될 때만 검토 중으로 돌아간다(오너 답 2026-11-02). 체결 이력이나 영구 자진신고가 있는 관리자는 제외하며, 가능한 관리자도 매번 이해관계가 없음을 명시 확인한다(#143·ADR-0120).
- **기한.** 검토 기한은 없다(#173 7항). 처리하지 않았거나 수용한 이의가 있으면 이의 기한이 지나도 결과가 확정되지 않고, 공개 화면에 그 시장은 기한 전에는 '이의 검토 중', 기한 뒤에는 '판정 지연'으로 보인다(오너 답 2026-11-03). 기한 뒤 늦어지면 판정 지연 기록으로 사유와 다음 검토 시각을 알린다(아래 '판정 지연 기록'). 기한 뒤 처리하지 않은 이의를 모두 기각하면(수용한 이의가 없으면) 워커가 몇 초 안에 결과를 확정한다.
- **수용은 정정이다.** 결과나 근거를 바꿀 것이 없으면 기각한다(#173 7항). 수용하면 시장은 판정 정정(아래 '판정 정정' — 다시 등록하고 다른 관리자가 승인한다)을 기다리며 잠정 결과에 머문다. 수용한 이의 줄의 '정정 등록'이 정정 양식을 연다. 수용해 두고 정정을 등록하지 않으면 시장은 확정되지 않은 채 남으니, 수용한 관리자나 다른 관리자가 곧 정정을 등록한다.
- **결정할 관리자가 없을 때.** 그 판정을 등록한 관리자 말고 처리할 관리자가 없으면 시장은 '판정 지연'으로 머문다 — 판정 지연 기록으로 그 사유를 공개하고(아래), 오너가 `/admin/admins`에서 관리자를 더 부여한다(ADR-0093 결정 4). 회원의 제출은 관리자의 수와 상관없이 받는다.
- **회원에게 알리기.** 알림은 없다(#188·#52). 낸 회원은 MY '판정 이의'에서 상태와 처리 사유를 본다 — 처리 사유는 회원이 읽고 #24의 공개 판정 기록에도 처리한 관리자 없이 보이므로 처음부터 공개 문장으로 적는다(ADR-0121). 처리한 관리자는 회원에게 보이지 않는다(#173 13항).
- **탈퇴한 회원.** 탈퇴한 회원이 낸 검토 중인 이의는 그대로 처리한다(관리자 화면에 '탈퇴한 사용자', ADR-0069 결정 4 #140). 기각·철회되거나 정정으로 종결된 것과 판정 버전이 바뀐 뒤의 수용된 것은 '신고·제재 기록' 보존기간이 지나면 근거 링크와 사유가 비워진다 — 행과 상태, 낸 계정(탈퇴한 계정)은 남는다. 지금 판정 버전의 수용된 이의(정정을 기다린다)는 비우지 않는다([SETTINGS.md](SETTINGS.md)).

## 판정 정정 (#176, ADR-0105)

잠정 결과로 공개한 판정이 틀렸으면 결과가 확정되기 전에 정정한다(ADR-0093 결정 1 #173 8항). 정정은 판정 등록과 같은 2인 통제다 — 한 관리자가 등록하고 등록하지 않은 다른 관리자가 승인한다(#173 2항). 결과가 확정된 뒤(결과 확정·지급 중·지급 완료)에는 정정하지 못하고, 지급 뒤의 오류는 보상(#144)으로 다룬다. 주문 접수(`order.accepting`)가 열리기 전에는 배포 환경에 체결이 없어 판정 이의에서 시작하는 정정은 없지만, 운영자가 찾은 오류의 정정은 된다.

- **언제.** 잠정 결과인 동안, 기다리는 판정(첫 판정이든 정정이든)이 없을 때만. 판정 이의를 수용했으면 그 이의가 정정으로 이어지고(#173 7항), 이의가 없어도 운영자가 오류나 이해관계를 찾으면 정정한다(#173 15항). 이의 기한이 지나면 워커가 곧 결과를 확정하므로 잡아 둔 것이 없는 시장의 정정은 기한 전에 등록한다 — 등록한 정정은 기다리는 동안 기한이 지나도 확정을 잡아 둔다.
- **등록.** 관리자 상세 판정 칸의 '판정 정정'(수용한 판정 이의 줄의 '정정 등록'도 같다)이 지금 판정으로 채운 등록 양식을 연다. 고칠 결과나 근거(판정 출처·대체 출처의 사유·무효 사유·증거 링크·수집 시각·확인한 내용)를 바꾸고 정정 사유(1\~500자)를 적는다 — 정정 사유는 판정 버전 이력에 남고 승인되면 #24의 공개 판정 기록에 보이므로 처음부터 공개 문장으로 적는다(ADR-0121). 아무것도 바꾸지 않은 정정은 받지 않는다. 바꿀 것이 없으면 정정하지 않고 그 이의를 기각한다(#173 7항). 판정 불가로 조기 마감한 시장(#114)은 정정도 무효로만 한다. 등록만으로는 판정과 결과가 바뀌지 않지만 그 정정이 결정되기 전에는 이의 기한이 지나도 결과가 확정되지 않고, 그 판정 버전에서 수용한 이의가 모두 그 정정과 함께 등록된다.
- **누가.** 어느 관리자나 등록한다 — 그 판정을 등록하거나 승인한 관리자와 이의를 수용한 관리자도. 승인·반려는 그 정정을 등록하지 않은 관리자 한 명이 한다. 기다리는 정정은 메뉴 '검수 대기'의 '판정 승인 대기'에 '판정 정정 v1 → v2'로 보인다. 결정할 다른 관리자가 없으면 등록부터 거절한다 — 오너가 `/admin/admins`에서 관리자를 더 부여한다(ADR-0093 결정 4). 체결 이력이나 영구 자진신고가 있는 관리자는 제외하며, 가능한 관리자도 매번 이해관계가 없음을 명시 확인한다(#143·ADR-0120).
- **승인하면.** 판정 버전이 하나 올라가고 새 결과가 잠정 결과로 바로 공개된다. 새 이의 기한은 첫 이의 기한과 같은 길이로 승인한 때부터 흐른다(#173 5항 — 출시 설정 `market.dispute_window`를 다시 읽지 않으니 설정을 바꾸었어도 그 시장의 첫 길이다). 바뀐 판정 버전의 검토 중인 이의는 '정정으로 종결'로 닫히고, 낸 회원은 새 기한 안에 새 판정에 다시 낸다(#173 8항). 수용한 이의는 수용으로 남는다. 예정 판정 시각 전이면 승인 창이 NO 조건과 그 사건 기한을 보이고 확인하게 한다. 공개 화면은 바뀐 결과와 새 이의 기한을 따르고, 공개 판정 기록은 승인된 새 근거·정정 사유와 이전 판정 버전을 함께 보인다(#24, ADR-0121). 반려·철회·승인 전의 등록과 내부 승인 사유는 공개하지 않는다. 회원에게 알리는 것도 없다(#188).
- **반려·철회하면.** 지금 판정 버전과 그 이의 기한·이의 처리 결과가 그대로 이어진다(결정 3 '#176 정정 대기'). 정정과 함께 등록된 수용한 이의는 검토 중으로 돌아가고(오너 답 2026-11-02 — 등록한 관리자의 철회도 같다, ADR-0105), 그 판정을 등록하지 않은 관리자가 그 이의를 다시 기각하거나 새 정정과 함께 다시 수용한다. 이의 기한이 이미 지났고 시장을 잡아 둔 것이 남지 않으면 워커가 몇 초 안에 원래 판정대로 확정한다.
- **기다리는 동안.** 기다리는 정정이 있으면 이의 기한이 지나도 확정하지 않는다. 공개 화면은 기한 뒤에 '판정 지연'으로 판정을 다시 검토하고 있다고만 말하고, 관리자 상세의 '판정 지연' 줄은 기다리는 정정을 말한다. 검토 기한은 없으니 오래 두지 말고 승인하거나 반려한다. 늦어지면 판정 지연 기록으로 사유와 다음 검토 시각을 알린다 — 그 사유에 '정정'을 쓰지 않는다(아래 '판정 지연 기록').
- **기록.** 바뀐 판정 버전은 지우거나 고칠 수 없고 판정 칸의 '판정 버전 이력'에 남는다(결과·출처·증거·수집 시각·공개 시각·이의 기한·등록하고 승인한 관리자·정정 사유). 등록·승인·반려·철회는 관리자 작업 기록에, 승인은 이벤트 로그의 '판정 정정'(이전 → 새 판정 버전과 결과, 새 이의 기한, 정정으로 종결한 이의의 수)으로도 남는다. 지급은 확정한 마지막 판정 버전으로 한 번이다(#126, ADR-0118). NULL인 옛 판정은 별도의 legacy 키로 한 번 지급한다.

## 판정 지연 기록 (#142, ADR-0106)

판정이 늦어지는 시장에 지연 사유와 다음 검토 시각을 남긴다(ADR-0093 결정 1 #173 11항, 결정 3 '#142 지연 사유'). 관리자 상세 판정 칸의 '판정 지연 기록'에서 '지연 기록 등록'으로 한다. 기록은 시장의 상태·결과·예정 판정 시각을 바꾸지 않는다 — 결과는 여전히 판정 등록과 다른 관리자의 승인으로만 생긴다(#152).

- **언제.** 시장이 '판정 지연'으로 보이는 동안만 기록한다: 예정 판정 시각이 지난 거래 마감 시장, 그리고 이의 기한이 지나도 처리하지 않았거나 수용한 판정 이의나 승인을 기다리는 판정 정정이 결과 확정을 잡아 둔 잠정 결과 시장이다(#173 7·11항 — 이의 검토에는 기한이 없으니 늦어지면 이 기록으로 알린다). 예정 판정 시각 전의 거래 마감 시장, 예정 판정 시각이 없는 시장(#22 전에 연 시장), 이의 기한 전이거나 잡아 둔 것이 없는 잠정 결과 시장은 받지 않는다 — 단추가 꺼지고 까닭이 보인다. 기록이 없어도 그 시각이 지나면 공개 화면에 '판정 지연'으로 보이니 곧 사유를 남긴다. 판정할 관리자가 모자라 기다리는 시장도 이 기록으로 사유를 공개하고, 오너가 `/admin/admins`에서 관리자를 더 부여한다(ADR-0093 결정 4).
- **누가.** 관리자 한 명이 승인 없이 바로 한다(#173 2항 — 거래 일시 중단과 같다). 그 시장의 판정을 등록한 관리자도 되고, 승인을 기다리는 판정이 있어도 된다.
- **지연 사유.** 공개 상세에 그대로 보이는 한 문장이다(1\~500자, 분류 없음 — 분류는 필요하면 M13이 더한다). 관리자의 이름을 적지 않는다 — 기록한 관리자와 기록 시각은 관리자 화면에만 남는다(#173 13항). 결과를 예상하거나 'NO'라고 적지 않는다 — 발표가 늦은 것만으로는 NO가 아니다(#172 8항). 승인을 기다리는 판정 정정이 있어도 '정정'이라고 쓰지 않는다 — 기다리는 정정은 공개하지 않는다(ADR-0105). 예: '1차 출처의 발표가 늦어지고 있습니다. 발표를 확인하는 대로 판정을 등록합니다.'
- **다음 검토 시각.** 한국 시간으로 적고 UTC로 저장한다. 공개 상세에는 보는 사람의 시간대와 판정 기준 시간대로 보인다. 지금보다 뒤이고 기록한 때부터 7일(7×24시간) 안이어야 한다 — 거래 마감과 잠정 결과 모두이고 출시 설정이 아닌 고정값이다(오너 답 2026-11-03, [SETTINGS.md](SETTINGS.md)). 서버가 DB 시계로 다시 보므로 창을 연 채 그 시각이 지나면 거절된다. 예정 판정 시각은 고치지 않는다 — 늦어지면 이 시각으로 알린다(#172 14항).
- **그 시각이 지나면.** 저절로 일어나는 것은 없다 — 결과도 판정도 무효도 생기지 않는다(#173 11항). 새 기록이 없으면 공개 상세는 사유를 그대로 두고 그 시각을 '갱신 대기'로 보이며, 판정 칸은 늦은 갱신 경고를 보인다(오너 답 2026-11-03). 다시 검토하고 새로 기록한다.
- **다시 기록하기.** 사유나 시각을 바꾸려면 새로 기록한다 — 고치거나 철회하는 길은 없다(오너 답 2026-11-03). 창은 지금의 사유로 채워 열린다. 새 기록이 지금의 기록이 되어 공개되고, 이전 기록은 '지연 기록 이력'에 기록 당시의 상태('거래 마감'이나 '잠정 결과 v1')와 함께 남는다. 잘못 적은 사유도 새 기록으로 바로잡는다 — 이전 것은 지울 수 없고 #24의 공개 기록에도 보이므로 처음부터 공개 문장으로 적는다(ADR-0121).
- **기록이 끝나는 때.** 판정이 승인되거나(잠정 결과), 정정이 승인되거나(새 판정 버전), 결과가 확정되면 그 전의 기록은 이력이 되고 공개 상세에서 빠진다. 다시 판정 지연이 되면 새로 기록한다 — 그때 판정 칸은 지금의 판정 버전에 지연 기록이 없다고 말하고, 공개 상세는 사유 없이 '판정 지연'이다. 정정이 반려되거나 철회되면 그 판정 버전의 기록이 그대로 지금의 기록이다.
- **장기 지연.** 장기 지연 기한(예정 판정 시각에서 규칙의 장기 지연 기한 날 수 뒤)이 지난 거래 마감 시장은 판정 칸 맨 위에 그 기한과 규칙의 '지연·취소·무효 처리'를 보이며 경고한다(오너 답 2026-11-03). 그 처리 — 대체 출처나 무효로 판정하는 것 — 는 판정 등록으로 적용하고 다른 관리자가 승인한다(#152). 자동으로 처리되는 것은 없고, 그런 시장의 목록은 #145다.
- **기록.** 기록마다 관리자 작업 기록(`market_delay_record`)과 이벤트 로그의 '판정 지연 기록'(지연 사유, 다음 검토 시각, 기록 당시)이 남는다. 회원에게 알리는 것은 없다(#188).

## 공개 판정 기록 (#24, ADR-0121)

이전 중단 양식에서 관리자만 본다고 안내한 설명은 계속 비공개다. 새 중단 설명은 공개 안내를 읽고 확인란을 선택한 뒤 제출하며, 배포 전에 열어 둔 양식은 새로고침한다. 공개 근거가 없는 옛 메모를 일괄 공개하거나 다시 공개하는 절차는 없다. 중단 사유 라벨·시각·검토 결과는 공개 기록에서 계속 확인할 수 있다.

시장 상세의 공개 판정 기록은 로그인 여부와 관계없이 같은 사실을 보인다. 머리의 원칙은 ‘판정은 규칙의 출처와 증거로 하며 시장가격이나 다수 의견으로 정하지 않습니다.’다. 별도 판정 원칙 문서(#136)의 링크는 아직 없다. 최신 승인 판정은 펼쳐 있고 이전 판정은 접어 읽는다. 기록 머리의 현재 상태는 상세 머리와 같아 ‘판정 지연’·‘이의 검토 중’도 구분한다. 옛 즉시 판정 시장처럼 판정 버전이 없으면 남아 있는 결과·시각만 보이고 근거를 만들어 넣지 않는다. VOID는 무효, CANCELLED는 취소이며 취소에는 판정·지급을 만들어 표시하지 않는다.

- **공개되는 입력.** 승인된 판정의 출처·대체 출처 사유·증거 링크·확인한 내용·수집 시각·무효/정정 사유, 중단 설명·결과 공개 시각·검토 결과, 현재와 이전 판정 지연 사유·다음 검토 시각, 이의 기각/수용 사유, 취소 사유다. 해당 관리자 양식의 공개 안내를 읽고 개인정보나 내부 조사 메모를 적지 않는다. 중단 설명은 중단 이력에 남아 재개 뒤에도 공개된다. 지연 기록도 새 기록이 이전 것을 지우지 않는다.
- **공개하지 않는 기록.** 판정자·검토자·처리자 신원, 이의 제출자·제출 본문/링크, 승인 전·반려·철회된 판정/정정, 재개·조기 마감·판정·정정의 내부 요청/승인/반려 사유다. 담당자 표기는 ‘운영자’다. 판정의 공개 ‘확인한 내용’과 요청/승인의 내부 결정 사유를 혼동하지 않는다.
- **이의 상태와 처리 이력.** 건수와 상태는 모든 판정 버전의 현재 행을 센다. 수용했던 이의를 정정 반려/철회로 다시 검토 중으로 돌려도 그때 공개한 수용 사유는 처리 이력에 남는다. 같은 과거 결정이 현재 행과 감사 이력에 모두 있으면 한 번만 보인다. 제출자가 탈퇴해 본문/링크가 보존기간 뒤 비워져도 건수·상태·처리 사유는 남는 기존 정책을 따른다.
- **결과와 지급.** 결과 확정 시각과 지급 완료 시각은 구분한다. SETTLING에서 정산 단계 실패, 완료한 Coin 단계의 최종 대사 오류(`last_error`), 원장 보류가 있으면 첫 실패부터 ‘지급 지연’으로 보인다. 오류 원문·SQL·스택·지급액은 공개하지 않는다. 결과 확정·지급 중에는 보이는 탭에서 5초마다 다시 읽어 상태 전이 없이 생긴 실패도 표시하고, 지급 완료가 되면 이 재조회를 멈추고 지연 표시를 내린다. 이 화면은 정산을 시작·중단·재시도하거나 Coin을 고치는 기능이 아니다.
- **시각과 이의 접수.** 회원 설정 시간대, 설정이 없거나 비로그인이면 브라우저 시간대를 쓰며, 판정 기준 시간대가 다르면 둘 다 보인다. 서버 HTML의 초기 시각은 기존 `DateTimeText` 규칙을 따른다. 잠정 결과의 이의 기한과 접수 링크도 방문자에게 보이고, 접수 자격은 기존 제출 화면이 검사한다.
- **새 상태의 기록을 기다릴 때.** 상태 변경을 먼저 받으면 새 기록을 읽을 때까지 이전 기록 전체와 확정/지급 시각을 숨기고 미갱신 안내를 보인다. 기록이 삭제됐다는 뜻이 아니다. 조회에 실패하거나 안내가 남아 있으면 요약의 ‘다시 시도’로 상세를 다시 읽는다. 읽는 중에는 단추가 비활성화된다. 가격만 갱신되어도 기록의 안내와 재시도는 유지하며, 같은 상태 또는 더 새로운 상태의 기록을 받은 뒤 없어진다. 이 단추는 조회만 다시 하고 정산·승인·Coin 이동을 실행하지 않는다.

새 마이그레이션·출시 설정·운영 수동 실행은 없다. 저장된 공개 대상 문장이 배포 후 상세에서 보이므로 배포 검토에서는 기존 문장의 공개 범위를 확인한다. 이 기능이 과거 근거나 사유를 고치거나 지우지는 않는다.

## 제재 이의 처리 (#45 14항)

회원은 운영자의 조치에 고객센터 이메일로만 이의를 낸다. 앱에는 제재 이의를 받거나 기록하는 화면이 없다(ADR-0069 결정 2 #45 14항, 결정 4의 #186 행 — 시장 결과에 대한 판정 이의는 앱 안에서 받는다, 위 '판정 이의 처리'). 회원이 보는 안내는 조치·신고 내역(`/my/moderation`)의 '받은 조치' 맨 위에 한 번 있고 — 고객센터 이메일로 받는다, 어느 조치인지(조치의 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄)를 적어 가입한 이메일로 보낸다, 조치마다 한 번·조치한 때부터 14일 안, 검토하는 동안 조치는 그대로, 결과는 이메일 — 취소되지 않은 조치의 카드마다 그 조치의 '이의 기한'(분까지 보이고, 그 분이 끝나면 '이의 기한이 지났습니다.'와 그 기한)이 있다. 카카오·네이버의 대체 주소 계정에게만 그 안내 아래에 '이의를 보내려면 MY 설정에서 이메일을 먼저 등록해 주세요.'와 MY 설정으로 가는 링크가 있다(오너 결정 2026-10-22 (2차) 3). MY 요약의 경고 띠, MY 요약·글쓰기 화면·MY 설정의 작성 제한 띠와 MY 요약·MY 설정의 계정 제한 띠(한 띠에 제한마다 제목·끝나는 때, 그 아래 링크 하나 — 계정 제한은 글쓰기 화면에 없다), 작성 제한·계정 제한 중의 거절(막힌 것과 끝나는 때·링크)과 MY '내 글'의 숨김 줄은 조치·신고 내역으로 잇기만 한다(ADR-0084, 오너 결정 2026-10-22·2026-10-23 답 6; ADR-0082; ADR-0085 7-10·7-11). 이메일 주소는 사업자 정보(`apps/web/src/legal/business-info.ts`의 `email`)이고 오너가 정할 때까지 회원에게 '미정'으로 보인다. 받기·검토·회신은 모두 앱 밖에서 한다. 보낸 사람의 계정과 그 회원이 받은 조치는 psql에서 읽기만 하고(2), 결과를 반영할 때만 관리자 화면(`/admin/moderation/…`)을 쓴다.

1. **대상.** 운영자의 모든 조치다 — 숨김·경고·닉네임 강제 변경·소개 비우기·프로필 이미지 삭제·작성 제한(#185)·계정 제한(#139). 계정 제한 중에도 받는다(#57 14항). 취소된 조치에는 이의할 것이 없다(회원의 카드에도 이의 기한이 없다). 작성 제한과 계정 제한은 기간이 지났거나 조기 해제·감경했어도 취소한 것이 아니라 그대로 조치다 — 조기 해제와 감경은 끝나는 때만 앞당기므로 이의 기한(조치한 때부터)은 그대로이고 회원의 카드에도 남는다(ADR-0082 7-3; 계정 제한은 다른 운영자가 승인한 변경으로, ADR-0085). 계정 제한의 '조치한 때'는 다른 운영자가 승인해 효력이 생긴 때다(ADR-0085 7-1) — 요청한 때가 아니고, 이의 기한도 그때부터다. 그래서 끝난 작성 제한·계정 제한에도 기한 안이면 이의를 받는다.
2. **보낸 사람.** 이의는 그 조치를 받은 회원 본인만 낸다 — 다른 회원이 받은 조치에는 이의를 낼 수 없다(#186의 수용 기준, N05 §5). 앱이 제재 이의를 받지 않으므로 이것은 이 절차로 지킨다(오너 결정 2026-10-22 답 5, ADR-0084).
   - 받는 메일: 그 계정의 지금 이메일(`user.email`)에서 보냈고 발신 인증을 통과한 메일만 이의로 받는다. 발신 인증은 [휴대전화 번호 바꾸기](#회원의-휴대전화-번호-바꾸기-57-3항)의 1단계와 같은 판정이다 — 고객센터 메일함의 메일 서비스가 그 메일을 받으며 스스로 매긴 판정 하나(메일 원본 맨 위의 `Authentication-Results` 줄이나 그 서비스가 따로 보여 주는 판정)만 보고, 그 아래의 다른 `Authentication-Results`·`ARC-Authentication-Results` 줄은 보지 않는다. SPF와 DKIM이 모두 `pass`이고 그 도메인이 둘 다 보낸 주소(From)의 도메인과 같거나, DMARC가 `pass`(그 판정의 `header.from`이 보낸 주소의 도메인)이면 통과다. 어느 쪽도 아니면 확인되지 않은 메일이다.
   - 계정 찾기: 보낸 주소의 계정과 그 회원이 받은 조치를 psql에서 찾는다 — 읽기만 한다. [휴대전화 번호 바꾸기](#회원의-휴대전화-번호-바꾸기-57-3항)의 2단계(셸)와 4단계(psql)로 붙어, 그 1단계의 계정 찾기처럼 보낸 주소를 `sender`에 넣고 아래를 돌린다. 계정의 이메일이 보낸 주소와 정확히 같은 계정만 나온다(계정의 이메일은 소문자로 저장되어 있어 보낸 주소를 소문자로 견준다). 줄이 없으면 그 주소는 어느 계정의 지금 이메일도 아니므로 확인되지 않은 메일이다. 줄이 있으면 `user_id`가 그 회원이고, 그 회원의 운영자 화면은 `/admin/moderation/users/<user_id>`다 — 결과를 반영할 조치가 거기에 있다. 줄마다 그 회원이 받은 조치 하나다(최신부터, 받은 조치가 없으면 `action_id`가 빈 줄 하나). `type`은 조치의 종류(`hide` 숨김, `warning` 경고, `nickname_reset` 닉네임 강제 변경, `bio_clear` 소개 비우기, `image_remove` 프로필 이미지 삭제, `writing_restriction` 작성 제한, `account_restriction` 계정 제한), `acted_kst`는 조치한 때(한국 시간, 초까지 — 계정 제한은 승인한 때), `deadline_kst`는 그 조치의 이의가 기한 안인 마지막 초 — 이의 기한(조치한 때 + 14×24시간)이 화면에 보이는 그 분의 끝(…:59, 한국 시간)이다(3). `cancelled`는 취소된 조치인지다 — 조기 해제하거나 감경한 작성 제한·계정 제한은 취소가 아니라 `f`다(1). `/admin/users`의 찾기로는 계정을 정하지 않는다 — 이메일·닉네임의 부분 일치라 다른 계정도 나오고, 한 번에 20개씩 최신 계정부터라 그 회원의 카드가 '더 보기' 뒤에 있을 수 있으며, 찾는 말은 100자까지라 그보다 긴 주소로는 찾지 못한다(ADR-0084 6-8).

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
   - 탈퇴한 계정(#140): 탈퇴한 계정은 더 이의를 낼 수 없다 — 로그인하지 못하고, 그 계정의 이메일은 탈퇴 때 지워져 자리표시 주소(`closed_<계정 id>@noemail.buddha.local`)가 되었다(ADR-0086 결과 5). 그래서 탈퇴 전의 이메일로 온 메일에는 위의 계정 찾기에 탈퇴한 계정의 줄이 나오지 않고, 이 절차의 다른 경우처럼 다룬다: 줄이 없으면 아래의 확인되지 않은 메일이고, 같은 이메일로 다시 가입한 계정의 줄이 나오면 그 줄들은 새 계정이 받은 조치뿐이다 — 탈퇴한 계정이 받은 조치는 이의의 대상이 아니다. 탈퇴 전에 받아 검토하던 이의는 그대로 검토해 결과를 반영하고 기록하되(3의 메일함 표시, 취소면 5의 운영 기록의 사유 — ADR-0069 결정 4 #140 «처리 중인 신고·이의·제안 → 그대로 검토하고 기록 (본인은 볼 수 없음)»), 회신은 하지 않는다 — 이의 메일함에 그 메일의 보낸 주소가 남아 있어도 그 주소로 보내지 않는다(오너 결정 2026-10-24 «검토 중에 탈퇴한 회원의 이의 → 그대로 검토하고 기록하되 답하지 않음(이의 메일함에 주소가 남아도)», ADR-0086). 6의 받는 사람인 그 계정의 지금 이메일도 이제 자리표시 주소다.
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
   - 취소: 그 조치의 '조치 취소'(대상 화면·회원 화면·조치 기록)를 쓰고, 운영 기록의 사유(회원에게는 보이지 않는다)에 이의를 받아들였음을 적는다. 숨긴 글·댓글은 다시 보이고 경고의 띠는 사라진다. 프로필 항목은 되살리지 않는다(#37 10항 — 회원이 다시 설정한다). 작성 제한을 취소하면 곧바로 풀리고 회원의 카드에는 끝나는 때 없이 '취소됨'과 취소한 때만 남는다 — 이미 끝난(기간이 지났거나 조기 해제한) 작성 제한도 취소할 수 있다(ADR-0082 7-15). 계정 제한(`account_restriction`)은 '조치 취소'가 받지 않으므로(`approval_required`) 회원 화면(`/admin/moderation/users/<user_id>`)의 그 조치 줄의 '취소 요청'을 쓰고, 요청의 사유(운영 기록, 회원에게는 보이지 않는다)에 이의를 받아들였음을 적는다. 다른 운영자가 '계정 제한 요청'(`/admin/moderation/account-restriction-requests`)이나 그 회원 화면에서 승인하면 그때 곧바로 풀리고 회원의 카드는 작성 제한의 취소와 같다 — 승인 전에는 바뀐 것이 없다. 이미 끝난 계정 제한도 취소를 요청할 수 있다(ADR-0056 결정 1-7, ADR-0085 7-4). 계정 제한을 승인할 때 취소된 대기 주문은 그 제한을 취소·감경·조기 해제해도 되살리지 않는다(위 '주문 취소').
   - 감경: 제한의 끝나는 시각을 앞당기는 것(무기한을 기간제로 바꾸는 것 포함)이라 작성 제한·계정 제한에만 있다. 작성 제한(`writing_restriction`)은 그 회원의 운영자 화면(`/admin/moderation/users/<user_id>`)의 그 조치 줄에서 서 있는 동안 '감경'(지금 끝보다 앞이고 아직 오지 않은 때로)이나, 지금 끝내려면 '조기 해제'를 쓴다 — 둘 다 운영 기록의 사유(회원에게는 보이지 않는다)에 이의를 받아들였음을 적는다. 회원의 조치·신고 내역에는 '감경됨'·'조기 해제됨'과 바뀐 끝, '원래 끝나는 때'가 보이고 이의 기한 줄은 그대로다(ADR-0082). 계정 제한(`account_restriction`)은 그 줄의 '감경 요청'(서 있는 동안, 지금 끝보다 앞이고 아직 오지 않은 때로)이나 '조기 해제 요청'을 쓰고 요청의 사유에 이의를 받아들였음을 적는다 — 다른 운영자가 승인해야 적용되고(ADR-0056 결정 1-7, ADR-0085), 그 뒤 회원의 카드는 작성 제한과 같다(승인 전에는 바뀐 것이 없다). 운영자에 관한 계정 제한이면 요청한 운영자도 그 운영자도 아닌 셋째 운영자가 승인하고, 그런 운영자가 없으면 요청을 받지 않는다(`no_decider`, ADR-0085 7-15). 조기 해제는 끝을 지금으로 앞당긴 감경이라 6의 회신에는 감경과 그 끝(해제한 때 — 계정 제한은 승인한 때)을 적는다. 경고로 낮추려면 취소한 뒤 경고를 건다(ADR-0069 결정 2 #45 14항).
6. **회신.** 결과는 이메일로 답한다. 앱의 알림은 없다(M13). 검토하는 사이 회원이 탈퇴한 이의에는 답하지 않는다(2의 '탈퇴한 계정', 오너 결정 2026-10-24).
   - 받는 사람: 그 계정의 지금 이메일(`user.email`)이다. 손으로 적거나 받는 사람이 정확히 그 주소인지 보고 보내고, 이의 메일의 답장 버튼으로 정하지 않는다 — 답장 버튼은 그 메일의 `Reply-To`로 보낼 수 있다. 제재 상태와 이의는 본인 전용이라(ADR-0069 결정 2 #45 12항, 결정 3 #37 11항) 결과를 그 계정의 주소 밖으로 보내지 않는다.
   - 적는 것(오너 결정 2026-10-22 답 7): 결과 — 유지·취소·감경, 감경이면 새로 끝나는 시각(한국 시간이라고 함께 적는다) — 와 그 설명이다. 설명은 회원이 조치·신고 내역에서 이미 보는 사유, 곧 운영자가 고른 신고 사유와 회원에게 보이는 운영자 설명 안에서만 한다.
   - 적지 않는 것: 회신은 앱 안의 안내와 같은 규칙을 따른다(ADR-0069 결정 2 #45 13항 '신고자와 처리한 운영자는 보이지 않는다'·10항, 결정 3 #37 11항). 누가 신고했는지와 몇 명이 신고했는지를 적지 않고, 신고의 설명을 옮기거나 풀어 쓰지 않으며, 조치하거나 취소하거나 검토한 운영자를 — 같은 운영자여도 — 밝히지 않고, 5의 운영 기록의 사유와 그 밖의 내부 사유를 옮기지 않는다. 회원의 조치·신고 내역도 이것들을 보이지 않는다(ADR-0081).
   - 보내는 이: 고객센터 주소에서 '고객센터'의 이름으로 보내고 운영자 개인의 이름을 쓰지 않는다 — 4대로 원 조치의 운영자가 검토할 수 있으므로 개인의 이름은 처리한 운영자를 드러낸다.
7. **절차가 정하지 않은 경우.** 이 절차의 규칙이 정하지 않은 드문 경우에는 운영자가 회원에게 유리하게 판단해 처리하고, 그 판단과 까닭을 그 메일의 메일함 메모(3의 표시를 다는 곳)에 적는다(오너 결정 2026-10-23 (3차)) — 예: 발신 인증에 계속 실패해 바꾼 이메일로 다시 보낸 메일이 두 회신 동안 기한을 넘긴 것(2), 늦은 되묻기 하나에 다시 온 이의가 여럿인 것, 한 번 더 되물은 뒤에도 맞는 조치가 없거나 함께 맞은 조치 가운데 받지 않는 것이 있는 것, 기한이 모두 지난 뒤의 되묻기나 첫 메일 뒤에 받은 조치처럼 늦은 되묻기인지가 갈리는 것, 다시 온 메일이 적으라고 한 것을 빼고 적었거나 조치한 때만 맞지 않아 어느 조치인지 분명하지 않은 것(3 — 그 자리에 적은 'ADR-0084 6-8'의 읽기는 이 판단의 출발점이다).

## 종료 시장의 마켓메이커 자금 회수 (#181, ADR-0125)

`market_maker.recall`은 종료 커밋 뒤 별도 트랜잭션으로 실행한다. 등록 누락·실행 오류는 매분 `market-maker-recall-scan`이 보완하며, 배포 전 이미 SETTLED/CANCELLED인 미완료 시장도 대상이다. 정상 실제 잔여 Coin 전액을 금고로 이전하고 완료를 한 번 기록한다. 0 Coin은 원장 없이 완료하며, 미배정 취소를 위해 자금 계정을 만들지 않는다. 회수는 발행·소각이나 사용자 지급 회수가 아니다.

시장별 MM 운영 화면의 회수 영역에서 미시도(NULL), 조건 대기, 시도 실패, 영구 완료를 구분한다. 최근 시도 시각·횟수와 최근 실패 시각을 확인할 수 있다. 원장 보류는 #93의 별도 두 관리자 복구 승인 전까지 유지하며, 금고 상한이면 일부 이전하지 않고 기다린다. 장부 불일치나 실행 오류를 원장 수정·잠금 해제로 숨기지 않는다. 원시 SQL 오류·계정 내부 식별자는 화면에 보내지 않는다. 이미 완료한 회수는 과거 사실이고 현재 보류/장부 정상의 보증은 아니다.

잡의 일시 오류는 3회 지수 백오프로 재시도하고 미완료 시장은 이후 스캔이 다시 확인한다. 스캔은 최대 500개를 오래 미시도한 순서로 처리해 한 실패 시장이 뒤의 시장을 막지 않게 한다. 현재 수동 실행 버튼이나 일반 운영 재시도 API는 없다. 향후 #145가 이 시장별 관측으로 연결하며, #181에서 통합 실패 목록을 먼저 구현하지 않는다. 운영 머지·배포는 별도 오너 승인 뒤 진행한다.
