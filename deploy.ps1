# 뉴스 브리핑 앱 자동 배포 스크립트
# 사용법: 이 파일을 더블클릭 or PowerShell에서 .\deploy.ps1

$env:PATH = $env:PATH + ";C:\Program Files\Git\cmd"
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "  📡 뉴스 브리핑 — GitHub 자동 배포" -ForegroundColor Cyan
Write-Host ""

# 변경된 파일 확인
$status = & 'C:\Program Files\Git\cmd\git.exe' status --short 2>&1
if (-not $status) {
    Write-Host "  ✅ 변경된 파일이 없습니다. 이미 최신 상태예요." -ForegroundColor Green
    Write-Host ""
    Read-Host "  Enter 키를 눌러 닫기"
    exit 0
}

Write-Host "  변경된 파일:" -ForegroundColor Yellow
$status | ForEach-Object { Write-Host "    $_" }
Write-Host ""

# 커밋 메시지 자동 생성 (날짜+시간)
$msg = "update: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"

# 스테이징 → 커밋 → push
& 'C:\Program Files\Git\cmd\git.exe' add -A
& 'C:\Program Files\Git\cmd\git.exe' commit -m $msg
$pushResult = & 'C:\Program Files\Git\cmd\git.exe' push origin main 2>&1

if ($LASTEXITCODE -eq 0 -or $pushResult -match "main -> main") {
    Write-Host ""
    Write-Host "  ✅ 배포 완료!" -ForegroundColor Green
    Write-Host "  🌐 https://sh94555405-afk.github.io/news-briefing/" -ForegroundColor Cyan
    Write-Host "  ⏱  1~2분 후 반영됩니다." -ForegroundColor Gray
} else {
    Write-Host ""
    Write-Host "  ❌ 오류 발생:" -ForegroundColor Red
    $pushResult | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
}

Write-Host ""
Read-Host "  Enter 키를 눌러 닫기"
