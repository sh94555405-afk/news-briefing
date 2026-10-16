@echo off
set GIT="C:\Program Files\Git\cmd\git.exe"
cd /d "D:\Downloads\my-news-app-starter"
%GIT% add -A
%GIT% commit -m "feat: GitHub Actions + Gemini 자동 수집 추가"
%GIT% push origin main
echo PUSH_DONE %ERRORLEVEL%
