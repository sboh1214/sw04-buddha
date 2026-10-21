# 이미지 변환 메모리 측정 (`scripts/image-memory/`)

API가 받은 이미지를 한 번 변환할 때(`apps/api/src/media/image.ts`의 `processImage` — 머리 검사 뒤 EXIF 방향대로 돌리고, 긴 변을 2,048px(`IMAGE_MAX_DIMENSION`) 안으로 줄여, 같은 형식으로 다시 인코딩한다) 쥐는 메모리를 **libvips가 센 최대 메모리**(`sharp.cache().memory.high`, MiB)로 잰다. 이 값으로 두 한도를 정했다(#46, ADR-0073 9-8, 오너 결정 2026-10-22):

- `IMAGE_MAX_SIDE_RATIO`(32) — 한 프레임의 긴 변은 짧은 변의 32배까지.
- `PNG_LARGEST_FRAME_PIXELS` — PNG는 종류(풀린 뒤의 채널·표본의 비트·인터레이스)마다 잰 한 프레임의 가장 큰 화소 수까지.

둘 다 받는 어느 이미지의 변환도 `IMAGE_DECODE_BUDGET_BYTES`(128MiB) 안이게 하는 한도다. 같은 줄에 프로세스의 최대 메모리(`maxRssMiB`)도 적는다 — libvips가 세지 않는 디코더 안(libpng 등)과 할당기의 몫이 거기에 더 든다.

**CI에서 돌지 않는다.** `pnpm test`·`pnpm check`·turbo의 어느 작업도 이 폴더를 부르지 않는다(루트 `scripts/`는 패키지가 아니다). 한 번에 수십 초\~수십 분이 걸리고 케이스마다 수백 MB를 쓴다. 회귀 시험은 따로 있다: `apps/api/src/media/image-memory.test.ts`가 이 스크립트로 찾은 가장 비싼 모양만 다시 변환해 128MiB 안인지 본다 — 이 스크립트는 그 모양과 값을 찾는다. `pnpm format`(prettier)은 이 폴더도 맞추고, ESLint와 tsc는 패키지마다 돌아 루트 `scripts/`를 보지 않는다(`scripts/generate-api-doc.mjs`와 같다).

## 파일

| 파일                | 하는 일                                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `measure.mjs`       | 변환 하나를 이 프로세스에서 잰다: 손수 만든 PNG(종류와 모양) 또는 JPEG·PNG·GIF·WebP 파일(`--file`). JSON 한 줄.                                                                                                               |
| `sweep-png.mjs`     | PNG 종류 하나의 한도(`--pixels`, 기본은 빌드의 `PNG_LARGEST_FRAME_PIXELS`)에서 9-8이 잰 모든 모양을 케이스마다 새 프로세스로 변환하고 가장 비싼 것을 적는다. `--search`는 그 종류의 가장 큰 프레임을 다시 찾는다.             |
| `measure-ratio.mjs` | PNG 종류의 가장 큰 프레임을 긴 변과 짧은 변의 비율마다 변환하고, 128MiB 안인 가장 큰 비율(`withinBudgetUpTo`)을 적는다. 종류를 주지 않으면 9-8의 여섯 경우(8비트 회색·RGB, ICC 프로필이 있고 없고, RGB는 EXIF의 90도 돌림도). |
| `lib.mjs`           | 공용: API 빌드와 sharp 읽기, PNG 만들기(`apps/api/src/test/png.ts`와 같은 종류·손수 만든 ICC 프로필), 새 프로세스로 재기.                                                                                                     |

## 돌리는 법

```sh
# 1. API를 먼저 빌드한다 — 스크립트는 빌드(apps/api/dist/media/image.js의 한도·processImage,
#    @buddha/shared의 IMAGE_MAX_DIMENSION·IMAGE_MAX_INPUT_PIXELS)와 apps/api의 sharp를 읽는다.
#    빌드가 image.ts보다 오래되었으면 경고한다.
corepack pnpm turbo run build --filter=api

# 2. 저장소 루트에서
node scripts/image-memory/measure.mjs --width 2000 --height 1000 --channels 4
node scripts/image-memory/measure.mjs --width 8192 --height 402 --channels 4 --depth 16 --profile
node scripts/image-memory/sweep-png.mjs --channels 4 --depth 16 --jobs 8
node scripts/image-memory/sweep-png.mjs --channels 4 --depth 16 --search --to 3600000 --jobs 8
node scripts/image-memory/measure-ratio.mjs --jobs 8
```

- **캐시 끔, 스레드 하나.** `measure.mjs`가 API처럼 `sharp.cache(false)`·`sharp.concurrency(1)`로 돈다.
- **케이스마다 새 프로세스.** libvips의 최대 메모리는 프로세스 전체의 값이고 내려가지 않는다. `measure.mjs`는 케이스 하나만 재고, 시작할 때 libvips가 아무것도 쥐지 않았는지 확인한다(아니면 실패). 두 훑기 스크립트는 케이스마다 `measure.mjs`를 새 프로세스로 띄운다 — `--jobs`개씩(기본 4) 함께 돌아도 값은 프로세스마다라 섞이지 않는다. 기계의 메모리만 본다(케이스마다 프로세스로 많게는 수백 MB).
- **PNG는 zlib로 손수 만든다.** 모든 표본이 0이라 파일은 작고(5,000만 화소 RGB가 146KB) 풀면 제 크기다. 행을 흘려 압축하므로 만드는 프로세스도 그 화소를 쥐지 않는다(`rssBeforeMiB`는 node·sharp·파일뿐이다). 종류는 `--channels 1|2|3|4`(회색·회색+알파·RGB·RGBA), `--depth 8|16`, `--interlaced`(Adam7), `--palette 1|2|4|8`, `--transparent`(`tRNS`), `--profile`(손수 만든 ICC v2 — `sweep-png.mjs`는 기본으로 넣고 `--no-profile`로 뺀다) 또는 `--icc <파일>`(실제 프로필, 예: macOS의 Display P3), `--orientation 1~8`(EXIF).
- **`--via sharp`(기본)과 `--via api`.** `sharp`는 `processImage`의 파이프라인을 머리 검사 없이 그대로 따라 한다(머리 읽기, `autoOrient`, 2,048px 안으로 줄이기, 같은 인코더) — 한도 밖의 모양도 잴 수 있다. `image.ts`의 파이프라인을 바꾸면 `measure.mjs`도 같이 바꾼다. `api`는 빌드한 `processImage` 그대로다(머리 검사까지 — 거절은 `refused`에 까닭, 아무것도 풀지 않았으면 `highMiB` 0).
- **출력은 JSONL.** `measure.mjs`는 한 줄을 stdout에(`--out <파일>`이면 그 파일에도 덧붙인다). 두 훑기 스크립트는 훑기마다 요약 한 줄을 stdout에 쓰고, `--out <파일>`에는 모든 케이스와 요약을 덧붙인다.
- 걸리는 시간(macOS arm64, `--jobs 8`): 케이스 하나 1초 안쪽, 16비트 RGBA 330만 화소의 촘촘한 훑기 775케이스 약 40초, 같은 종류의 `--search --to 3600000` 약 2분 반(거친 훑기 셋, 촘촘한 훑기 넷), `measure-ratio.mjs`의 기본 54케이스 10초 안쪽. 한도가 큰 종류(5,000만 화소)는 축소가 오르는 너비가 많아 촘촘한 훑기가 몇 분이다.

열여섯 종류를 모두 지금 한도에서 훑기:

```sh
for depth in 8 16; do for channels in 1 2 3 4; do for il in "" --interlaced; do
  node scripts/image-memory/sweep-png.mjs --channels $channels --depth $depth $il --jobs 8 \
    --out png-sweep.jsonl
done; done; done
```

## 훑는 모양과 찾는 법 (9-8)

PNG의 변환이 쥐는 것은 화소보다 모양에 달렸다. libvips는 보통 PNG를 행의 띠로, 인터레이스는 통째로 읽고, 줄이며 프레임 너비의 입력 행을 쥐는데, libvips의 정수 세로 축소가 한 단 오르기 직전(세로 비율이 4·6·8… 바로 아래 — 프레임을 2,048px 안에 맞추므로 너비가 2,048의 짝수 배인 곳)에 가장 많이 쥔다. 그래서 `sweep-png.mjs`는 한 값의 화소로 된 가로로 긴 프레임(가로 ≥ 세로, 32:1까지)을 훑는다:

- a. 1:1부터 32:1까지 너비 50px 간격(`--coarse`는 100px), 그 화소의 가장 큰 높이.
- b. 축소가 오르는 너비들(2,048 × 4, 6, 8 …) 둘레(-400\~+60px)와 32:1 끝(-400px)에서 너비 4px 간격, 가장 큰 높이와 세로 비율이 그 단 바로 아래인 높이 둘.
- c. EXIF로 90도 도는 프레임(방향 6)은 4:1까지 50px 간격(sharp는 줄인 뒤에 돌리고, 세로로 저장된 프레임은 훨씬 적게 쥔다).

`--search`는 9-8이 값을 찾은 차례다: `--from`(기본 지금 한도)과 `--to`(기본 5,000만, `IMAGE_MAX_INPUT_PIXELS`) 사이에서 거친 훑기(a, 100px)의 가장 비싼 프레임이 `--target`(124MiB) 이하인 10만 화소 단위의 가장 큰 값을 반씩 나눠 찾고(`--to`가 그 안이면 `--to`), 그 값의 촘촘한 훑기가 `--limit`(126MiB)를 넘으면 낮췄다가 다시 반씩 나눠 그 안인 가장 큰 값으로 올린다. 126은 잰 모양 사이의 모양을 위한 128MiB 아래의 여유다(50px 간격으로만 재면 350만 화소 16비트 RGBA가 124MiB였는데 촘촘히 재면 128MiB였다). 마지막 줄(`type: "result"`)의 `largestFrame`이 그 값이다.

## ADR-0073 9-8의 값이 뜻하는 것

**비율 32.** 8비트 회색·RGB PNG가 가질 수 있는 가장 큰 프레임(5,000만 화소)을 비율마다 변환한 libvips의 최대 메모리: RGB 1:1 33MiB, 8:1 93, 16:1 101, 32:1 116(EXIF의 90도 돌림도 116), 40:1 124, 44:1 126, 48:1 132, 64:1 145, 100:1 162MiB, 회색 32:1 39, 100:1 54MiB. ICC 프로필이 들면 sharp가 줄이기 전에 sRGB로 바꾸므로 더 쥔다 — 32:1에서 RGB 118, 회색 73MiB. 128MiB를 넘기 전(44\~48:1)의 둥근 값에서 10MiB쯤 여유를 두어 32다. `measure-ratio.mjs`의 `withinBudgetUpTo`가 그 '넘기 전'이다(지금 44). 그것이 32 근처로 내려오거나 32:1의 값이 여유를 잃으면 비율을 다시 정한다. 머리의 다른 검사를 모두 지나는 5,000,000×10(`--ratios 500000`)은 libvips로 회색 약 500MiB, RGB 약 1.5GiB를 쥔다 — 기계의 메모리를 보고 돌린다.

**PNG 종류마다의 가장 큰 프레임.** 프로필이 있든 없든 종류마다 값 하나다(오너 결정 2026-10-22 — 잰 그대로 승인). 손수 만든 프로필을 넣어 쟀다(프로필이 없는 파일은 같은 모양에서 0\~50MiB 덜 쥐었다). 팔레트는 RGB(투명이 있으면 RGBA)로, 투명색이 든 회색·RGB는 회색+알파·RGBA로 풀려 그 종류의 값을 받는다. 가장 비싼 프레임이 `image-memory.test.ts`가 변환하는 모양이다.

| 종류(풀린 뒤)         | 플래그                                 | 가장 큰 프레임(화소)       | 가장 비싼 프레임 | libvips 최대 |
| --------------------- | -------------------------------------- | -------------------------- | ---------------- | ------------ |
| 8비트 회색            | `--channels 1`                         | 50,000,000                 | 24,372×2,051     | 73MiB        |
| 8비트 회색 인터레이스 | `--channels 1 --interlaced`            | 50,000,000                 | 20,480×2,439     | 110MiB       |
| 8비트 회색+알파       | `--channels 2`                         | 37,000,000                 | 32,712×1,131     | 125MiB       |
| 〃 인터레이스         | `--channels 2 --interlaced`            | 24,500,000                 | 16,050×1,526     | 124MiB       |
| 8비트 RGB             | `--channels 3`                         | 50,000,000                 | 39,972×1,250     | 118MiB       |
| 〃 인터레이스         | `--channels 3 --interlaced`            | 26,400,000                 | 16,139×1,635     | 125MiB       |
| 8비트 RGBA            | `--channels 4`                         | 19,700,000                 | 24,576×801       | 125MiB       |
| 〃 인터레이스         | `--channels 4 --interlaced`            | 15,700,000                 | 8,160×1,924      | 125MiB       |
| 16비트 회색           | `--channels 1 --depth 16`              | 50,000,000                 | 39,872×1,254     | 77MiB        |
| 〃 인터레이스         | `--channels 1 --depth 16 --interlaced` | 41,943,040(전의 값 그대로) | 20,477×2,048     | 121MiB       |
| 16비트 회색+알파      | `--channels 2 --depth 16`              | 25,900,000                 | 28,600×905       | 125MiB       |
| 〃 인터레이스         | `--channels 2 --depth 16 --interlaced` | 17,300,000                 | 11,960×1,446     | 124MiB       |
| 16비트 RGB            | `--channels 3 --depth 16`              | 13,100,000                 | 20,304×645       | 125MiB       |
| 〃 인터레이스         | `--channels 3 --depth 16 --interlaced` | 10,300,000                 | 11,910×864       | 124MiB       |
| 16비트 RGBA           | `--channels 4 --depth 16`              | 3,300,000                  | 8,192×402        | 126MiB       |
| 〃 인터레이스         | `--channels 4 --depth 16 --interlaced` | 4,600,000                  | 8,192×559        | 126MiB       |

5,000만(`IMAGE_MAX_INPUT_PIXELS`)과 41,943,040은 측정 전에 이미 그 안이던 종류가 지닌 전의 한도다(형식의 값으로는 더 받을 수 있다). JPEG·GIF·WebP의 화소마다의 값(`decodeBytesPerPixel`)은 이 스크립트가 다시 찾지 않는다 — 그 한도 근처의 파일을 `measure.mjs --file`로 재어 본다.

**주의: macOS arm64에서 잰 값이다**(sharp 0.35.5, libvips 8.18.7). 운영(linux arm64, glibc 컨테이너)에서는 다시 재지 않았고, libvips가 센 값이라 디코더 안과 할당기의 몫은 빠진다 — 가장 비싼 프레임의 프로세스 최대 메모리는 182\~233MiB였다(아무것도 하지 않는 같은 프로세스 63MiB, ADR-0073 결과 5). 줄마다 `sharp`·`vips`·`platform`이 함께 적힌다.

## 언제 다시 재나

- **sharp나 libvips를 올릴 때**(`pnpm-workspace.yaml`의 catalog `sharp`): 디코더와 축소가 쥐는 것이 바뀌면 가장 비싼 모양도 옮겨 갈 수 있다. `image-memory.test.ts`는 잰 모양만 보므로 다른 모양이 비싸져도 지날 수 있다.
- **`IMAGE_MAX_DIMENSION`(2,048)을 바꿀 때**: 가장 비싼 모양은 그 값의 짝수 배 너비에 달렸다 — 바꿔도 회귀 시험은 그대로 지날 수 있다. `IMAGE_MAX_INPUT_PIXELS`·`IMAGE_DECODE_BUDGET_BYTES`·`IMAGE_MAX_SIDE_RATIO`나 `processImage`의 파이프라인(인코더 설정 포함)을 바꿀 때도.
- **운영의 Linux에서 확인할 때**: api 이미지에는 빌드와 sharp가 들어 있다(소스는 없다 — 오래된 빌드의 경고는 건너뛴다). 이 폴더를 붙여 그 안에서 돌린다(이 절차로는 아직 재지 않았다):

  ```sh
  docker buildx build --platform linux/arm64 --target api -t buddha-api:local .
  docker run --rm -v "$PWD/scripts:/app/scripts:ro" --entrypoint node buddha-api:local \
    scripts/image-memory/sweep-png.mjs --channels 4 --depth 16 --jobs 4
  ```

다시 잴 때: 열여섯 종류를 지금 한도에서 훑고(위의 반복) `measure-ratio.mjs`를 돌린다. 어느 종류의 `maxMiB`가 126을 넘거나 `withinBudgetUpTo`가 32보다 작으면, 그 종류를 `--search --to <지금 한도>`로 다시 찾아 `PNG_LARGEST_FRAME_PIXELS`(또는 비율)를 낮추고, 마지막 훑기의 가장 비싼 프레임(`top`의 첫째)으로 `image-memory.test.ts`의 모양을 고치고, ADR(9-8)에 새 값과 잰 환경을 적는다. 값을 올리려면 `--search`를 `--to` 없이(5,000만까지) 돌린다.
