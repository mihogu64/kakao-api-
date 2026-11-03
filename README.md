# GPS Kakao Map

## 개인 PC에서 실행

1. Node.js LTS를 설치합니다.
2. 이 프로젝트 폴더의 `start-server.bat`을 더블클릭합니다.
3. 검은색 서버 창을 닫지 않은 상태에서 브라우저로 `http://localhost:3000`에 접속합니다.

PowerShell을 사용할 때는 프로젝트 폴더에서 다음 명령을 실행해도 됩니다.

```powershell
npm.cmd start
```

## 다른 기기에서 접속

서버 창에 표시되는 `Network sharing URL`의 주소를 같은 Wi-Fi에 연결된 휴대폰이나 다른 PC에서 엽니다.

예: `http://192.168.45.218:3000` (서버 창에 표시된 주소 사용)

다른 기기에서 접속되지 않으면 Windows 방화벽에서 Node.js의 개인 네트워크 통신을 허용해야 합니다. 서버 창은 접속하는 동안 계속 실행되어 있어야 합니다.

## 페이지가 로드되지 않을 때

- `http://localhost:3000` 주소인지 확인합니다.
- `start-server.bat`을 다시 실행합니다.
- 서버 창에 오류가 있는지 확인합니다.
- 이미 다른 프로그램이 3000번 포트를 사용 중이면 PowerShell에서 `$env:PORT=3001; npm.cmd start`를 실행하고 `http://localhost:3001`로 접속합니다.

현재 사용자와 타일 데이터는 메모리와 `data/state.json`에 저장됩니다. Render 재시작 후에도 유지하려면 아래 Supabase 설정을 추가하세요.

## Supabase 영구 저장 설정

1. Supabase 프로젝트를 만들고 SQL Editor에서 [`schema.sql`](./schema.sql)의 내용을 실행합니다.
2. Supabase의 Project Settings > API에서 Project URL과 `service_role` 키를 확인합니다.
3. Render Web Service의 Environment에 다음 변수를 추가합니다.

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

`SUPABASE_SERVICE_ROLE_KEY`는 서버 환경 변수에만 저장하고 브라우저 코드나 GitHub에 공개하지 마세요. 서버가 시작될 때 Supabase의 저장 상태를 복원하고, 계정·팀·타일 변경 후 최신 상태를 자동으로 저장합니다. 환경 변수가 없으면 기존 `data/state.json` 방식으로 동작합니다.

## 공유 저장 동작

현재 버전부터 로그인한 사용자의 마지막 위치와 칠한 타일은 서버의 `data/state.json`에 저장됩니다. 따라서 같은 서버를 다시 시작해도 저장된 계정, 위치, 타일을 복구할 수 있습니다. 로그인한 다른 사용자는 5초마다 다른 사용자의 최근 위치와 공유 타일을 받아 지도에서 확인합니다.

`data/state.json`은 운영 계정 정보가 포함되는 파일이므로 GitHub에 올리지 마세요. Supabase를 연결한 뒤에도 로컬 개발용 백업 파일로만 사용됩니다.