@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 설치되어 있지 않습니다.
  echo https://nodejs.org 에서 Node.js LTS를 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)

echo 서버를 시작합니다.
echo 브라우저에서 http://localhost:3000 을 여세요.
echo 종료하려면 이 창에서 Ctrl+C를 누르세요.
echo.
node server.js
pause