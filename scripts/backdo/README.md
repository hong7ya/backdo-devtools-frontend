# BackDo 재실행 방식

BackDo는 실행 위치의 순서를 기록하고, 대상 Node 프로세스를 처음부터 다시 실행해 직전 위치로 돌아간다. 기록에는 파일 URL, 소스 해시, 줄, 열만 들어간다. 변수와 힙을 저장하거나 복원하지 않는다.

이번 구현의 기록 범위는 실행 관리기로 시작한 **Node 진입 파일 한 개**다. 같은 파일에 정의된 함수와 콜백의 위치를 포함한다.

## 빌드와 실행

저장소 루트에서 실행한다.

```sh
npm run build
node out/Default/gen/scripts/backdo/debug.js scripts/backdo/fixtures/for.js
```

터미널에 출력된 주소를 Chrome에서 연다. `js_app.html` 화면에서 대상 프로세스가 처음 멈추면 다음 순서로 확인한다.

1. `return total;`에 일반 브레이크포인트를 건다.
2. Resume을 눌러 그 위치까지 실행한다.
3. 뒤로가기 버튼을 누른다. 마지막 `i < 4` 조건식으로 이동하며, 스코프의 `i`는 `4`, `total`은 `12`다.
4. 한 번 더 누르면 그 직전 증감식으로 이동한다.

대상 코드 인자는 파일 경로 뒤에 붙인다. `Ctrl+C`를 누르면 실행 관리기가 시작한 프로세스와 서버를 종료한다. 다른 예제는 실행 관리기를 종료한 뒤 새로 시작한다.

```sh
node out/Default/gen/scripts/backdo/debug.js scripts/backdo/fixtures/async-await.js
node out/Default/gen/scripts/backdo/debug.js scripts/backdo/fixtures/for-of-break.js
```

빌드 결과가 다른 디렉터리에 있으면 `--frontend-dir`을 사용한다.

```sh
node out/Default/gen/scripts/backdo/debug.js --frontend-dir /빌드한/front_end /대상/entry.js
```

소스는 TypeScript다. 기존 `node_ts_library`가 실행 관리기와 Node 테스트를 CommonJS JavaScript로 컴파일한다. `fixtures/*.js`는 디버깅 대상 JavaScript 예제다.

## 실행 흐름

```text
일반 브레이크포인트로 실행 위치 기록
                  ↓
뒤로가기 버튼 → 기록의 직전 위치 선택
                  ↓
기존 연결 종료 → 대상 프로세스 재시작
                  ↓
같은 포트의 /json/list에서 새 WebSocket 조회
                  ↓
같은 탭에서 실제 연결과 주소 교체
                  ↓
일반 브레이크포인트로 처음부터 재실행
                  ↓
매 정지마다 기록의 위치·순서·소스 해시 대조
                  ↓
목표 도달 → 최종 정지만 UI에 전달 → 화면 전환
```

`history.replaceState`는 실제 새 연결이 응답한 뒤 호출한다. 문서와 탭을 유지하고 기존 `history.state`도 보존한다. 재실행 도중의 정지는 SDK에서 소비하므로 Sources 패널은 최종 정지만 받는다.

| 코드 | 책임 |
| --- | --- |
| `front_end/models/replay/ExecutionHistory.ts` | 위치 기록과 전체 경로 대조 |
| `front_end/models/replay/ReplaySession.ts` | 실행 명령에 따른 정지 판단과 복원 후 이력 갱신 |
| `front_end/models/replay/ReplayController.ts` | 기록용 브레이크포인트, 재시작 요청, 복원 완료·실패 처리 |
| `scripts/backdo/ManagedProcess.ts` | 자식 프로세스의 시작·종료·재시작과 새 연결 조회 |
| `scripts/backdo/DebugServer.ts` | 프런트엔드 파일 제공과 현재 세션의 재시작 요청 처리 |
| `front_end/entrypoints/js_app/js_app.ts` | SDK 대상과 실제 WebSocket 연결 교체 |
| `front_end/panels/sources/ReplayTransition.ts` | 이전 화면 유지와 최종 화면 전환 |

## 테스트

프런트엔드 단위 테스트는 기존 규약대로 소스 옆의 `*.test.ts`에 두고 Mocha·Chai·Sinon을 Karma에서 실행한다. Node 통합 테스트도 TypeScript로 작성하며, 빌드된 테스트를 Mocha·Chai로 실행하도록 기존 테스트 러너에 등록했다.

전체 빌드 후 필요한 테스트만 실행할 수 있다.

```sh
npm test -- --skip-ninja front_end/models/replay front_end/core/sdk/DebuggerModel.test.ts
npm test -- --skip-ninja scripts/backdo/tests
```

Node 통합 테스트는 저장소의 Chrome for Testing 경로를 기본으로 사용한다. 다른 Chrome은 `CHROME_BIN` 환경 변수로 지정한다. 별도로 빌드한 화면을 검사할 때는 `BACKDO_FRONTEND_DIR`로 해당 `front_end` 경로를 지정한다.

검증한 항목은 다음과 같다.

- `for`와 `async/await`에서 마지막 조건식으로 복원하고, 한 번 더 되돌리는 동작
- `for...of + break`에서 실제 직전 위치로 복원하는 동작
- 실행되지 않는 분기에 `new Error()`가 있어도 복원하는 동작
- 프로세스 PID와 WebSocket ID의 변경, Inspector 포트의 유지
- 문서 재요청 없이 주소와 실제 연결을 교체하고, 최종 정지 한 번만 UI에 전달하는 동작
- 소스 변경 시 복원 실패와 버튼 비활성화
- 새 연결이 응답하지 않을 때 제한 시간 후 작업 중 상태 해제

개발 검증 환경은 Node 20.19.2와 Chrome 156이다. 수정 소스를 별도 디렉터리에 컴파일한 화면으로 브라우저 단위 테스트 30개와 Node 통합 테스트 5개를 통과했다. 새 실행 관리기의 GN 대상 빌드, GN 설정, GRD 리소스 목록, 변경 파일의 ESLint 검사도 통과했다.

전체 프런트엔드 빌드는 최종 확인 항목이다. 소스의 의존 경로를 함께 검사한 TypeScript 검사에는 `front_end/panels/settings/KeybindsSettingsTab.ts:133`의 기존 타입 오류 한 건이 남았다. 작업 시작 전 커밋에서도 같은 오류를 재현했다.

## 지원 범위와 한계

- 실행 관리기가 새 프로세스를 시작한 첫 정지부터 사용한다. 실행 중인 프로세스에 중간부터 붙거나 기록 도중 화면을 새로고침하는 흐름은 지원 범위가 아니다.
- 브라우저 페이지, 다중 모듈, Worker, 여러 프로세스, 동적 `eval` 스크립트의 전체 실행 기록은 구현하지 않았다.
- Step into는 기록 대상 파일의 다음 정지 위치로 이동한다. Step over와 Step out은 동기 호출 스택 깊이를 기준으로 판단하므로, 비동기 경계를 넘는 이동을 Chrome의 기본 동작과 동일하다고 보장하지 않는다.
- 위치 순서가 같아도 변수 값이 같다는 뜻은 아니다. 시간, 난수, 외부 입력, 비동기 처리 순서가 달라지면 같은 상태의 복원을 보장하지 못한다. 위치 순서나 소스 해시가 달라지는 경우에는 복원을 실패 처리한다.
- 목표 위치까지 다시 실행한 코드의 파일 쓰기, 요청, 로그 등의 부작용은 다시 발생한다. 외부 상태를 되돌리지는 않는다.
- 기록을 끊는 브레이크포인트 비활성화, 일시적인 모든 정지 건너뛰기, 소스 편집이 감지되면 해당 세션의 뒤로가기를 막는다. 실패 후에는 실행 관리기를 새로 시작한다.
- 이력 한도는 100만 위치, 복원 제한 시간은 30초다. 일반 브레이크포인트를 매번 거치므로 긴 실행과 많은 반복에는 비용이 크다.
- 화면 전환은 View Transitions를 사용한다. 긴 재실행이나 숨겨진 탭에서는 브라우저가 전환을 생략할 수 있다.

## 가독성 정리 기준

[구현 상세 추상화하기](https://frontend-fundamentals.com/code-quality/code/examples/login-start-page.html)와 [숨은 로직 드러내기](https://frontend-fundamentals.com/code-quality/code/examples/hidden-logic.html)를 적용해 공개 메서드에서 실행 흐름을 먼저 읽고, 아래에서 통신과 이벤트 처리의 상세를 확인하도록 정리했다.

`ReplaySession.recordPause`는 위치를 기록한다는 동작을 이름에 드러내고, `show` 또는 `continue`를 반환한다. 호출부가 서로 반대 의미의 boolean을 해석하는 부담을 줄였다. Node 통합 테스트에서는 브라우저 내부 접근을 `ReplayTestHarness`로 모아 테스트 본문에 준비·행동·검증이 드러나도록 했다.
