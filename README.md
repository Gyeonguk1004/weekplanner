# 위크플래너

월요일부터 일요일까지 한 주의 할 일을 적고, 끝낸 일은 체크해서 줄을 긋는 플래너예요.
Google 계정이나 이메일로 로그인하면 컴퓨터와 휴대폰에서 같은 목록을 쓸 수 있어요.

- 주간 보기(기본)와 월간 보기
- 화면을 옆으로 끌거나 ‹ › 버튼으로 지난주·다음 주 이동
- 세부 업무: 맨 앞에 띄어쓰기 한 칸을 넣고 입력하거나, 할 일 옆 ↳ 버튼
- 복사: Ctrl(Mac은 ⌘)을 누른 채 할 일을 다른 요일로 끌기 (휴대폰은 길게 누른 채 끌기). 먼저 날짜에서 나중 날짜로 화살표가 이어져요.

## 파일 구성

| 파일 | 하는 일 |
| --- | --- |
| `index.html` | 화면과 디자인 |
| `app.js` | 플래너 기능, 로그인, 저장 |
| `firebase-config.js` | **내 Firebase 프로젝트 설정값을 넣는 곳** |
| `firestore.rules` | 각자 자기 할 일만 보게 하는 보안 규칙 (Firebase 콘솔에 붙여넣기) |
| `manifest.webmanifest`, `icons/` | 휴대폰 홈 화면에 앱처럼 설치할 때 쓰는 이름과 아이콘 |

---

## 1. Firebase 준비

지원노트와 섞이지 않게 **새 프로젝트**를 만드는 걸 추천해요. Storage를 쓰지 않아서 카드 등록 없이 무료 요금제(Spark)로 쓸 수 있어요.

1. [Firebase 콘솔](https://console.firebase.google.com)에서 **프로젝트 추가** → 이름 예: `weekplanner`. Google 애널리틱스는 꺼도 돼요.
2. **빌드 → Authentication → 시작하기 → 로그인 방법**에서 두 가지를 사용 설정해요.
   - **Google** (프로젝트 지원 이메일은 본인 Gmail 선택)
   - **이메일/비밀번호**
3. **빌드 → Firestore Database → 데이터베이스 만들기**
   - 위치: `asia-northeast3 (서울)`
   - **프로덕션 모드**로 시작
4. Firestore의 **규칙** 탭에서 내용을 지우고 `firestore.rules` 파일 내용을 붙여넣은 뒤 **게시**해요.
5. **프로젝트 설정(톱니바퀴) → 일반 → 내 앱 → 웹(`</>`) 아이콘**으로 웹 앱을 추가해요. (Firebase 호스팅은 체크하지 않아요.)
   화면에 나오는 `firebaseConfig` 값들을 `firebase-config.js`에 그대로 옮겨 적어요.
6. **Authentication → 설정 → 승인된 도메인 → 도메인 추가**에 아래 주소를 넣어요.
   ```
   gyeonguk1004.github.io
   ```
   이게 빠지면 GitHub 주소에서 로그인할 때 "승인된 도메인" 오류가 나요.

> **기존 myfuturerecord 프로젝트에 붙이고 싶다면**
> - `firebase-config.js`에는 지원노트와 같은 설정값을 넣어요.
> - 규칙은 **절대 통째로 덮어쓰지 마세요.** 지원노트가 멈춰요. `firestore.rules` 안의 `match /weekplanner/...` 블록만 기존 규칙 안에 추가해요.
> - 데이터는 `weekplanner` 컬렉션에 따로 저장돼서 지원노트 데이터와 섞이지 않아요.

## 2. GitHub Pages에 올리기

1. [github.com/new](https://github.com/new)에서 새 저장소를 만들어요. 이름 예: `weekplanner`, **Public**.
   (무료 계정은 공개 저장소에서만 Pages를 쓸 수 있어요. 할 일 데이터는 저장소가 아니라 Firebase에 있어서 공개돼도 괜찮아요.)
2. 저장소 첫 화면의 **uploading an existing file**을 눌러 이 폴더의 파일을 **전부** 끌어다 놓고(`icons` 폴더 포함) **Commit changes**.
3. **Settings → Pages → Build and deployment**에서 Source는 `Deploy from a branch`, Branch는 `main` / `(root)`로 고르고 **Save**.
4. 1~2분 뒤 아래 주소로 열려요.
   ```
   https://gyeonguk1004.github.io/weekplanner/
   ```

고친 파일은 같은 저장소에 다시 올리면 1~2분 뒤 반영돼요. 휴대폰에서 예전 화면이 보이면 새로고침해 주세요.

## 3. 휴대폰에 설치하기 (갤럭시)

1. **Chrome**으로 위 주소를 열고 로그인해요.
2. 오른쪽 위 **⋮ → 홈 화면에 추가 → 설치**를 눌러요.
3. 홈 화면 아이콘을 누르면 주소창 없이 앱처럼 열려요. 아이콘을 **길게 누르면** "이번 주", "이번 달" 바로가기가 나와요.

아이폰은 Safari → 공유 → **홈 화면에 추가**예요. 홈 화면 앱은 Safari와 로그인이 따로라서 한 번 더 로그인해야 하고, Google 로그인이 안 되면 이메일 로그인을 써 주세요.

## 4. 지인에게 공유하기

- 주소만 보내면 돼요. 각자 자기 Google 계정이나 이메일로 가입해서 **따로** 써요.
- 보안 규칙 때문에 다른 사람의 할 일은 서로 볼 수 없어요.
- 가입한 사람은 Firebase 콘솔 **Authentication → 사용자**에서 볼 수 있어요.
- 프로젝트 관리자(본인)는 Firebase 콘솔에서 저장된 데이터를 열어볼 수 있어요. 공유할 때 이 점은 미리 알려 주세요.

## 문제가 생기면

| 화면에 보이는 것 | 확인할 곳 |
| --- | --- |
| "아직 Firebase가 연결되지 않았어요" | `firebase-config.js`에 설정값을 넣었는지 |
| 로그인할 때 "승인된 도메인" 오류 | 1-6단계 승인된 도메인 |
| "이 로그인 방식이 꺼져 있어요" | 1-2단계 로그인 방법 |
| "권한이 없어요 · 보안 규칙을 확인해 주세요" | 1-4단계 규칙을 게시했는지 |
| 화면이 안 바뀜 | 1~2분 기다린 뒤 새로고침 |

## 데이터 구조

```
weekplanner/{사용자 uid}/days/{YYYY-MM-DD}
  date:  "2026-10-28"
  items: [ { id, text, done, sub?, group? } ]
```
`sub: true`는 바로 위 할 일의 세부 업무, 같은 `group`을 가진 할 일은 복사로 이어진 할 일이에요.
