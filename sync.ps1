# dev-env-sync Windows 一键上传（sync.bat 调用）
# 把本机改动提交并推送到：个人私有库 + 公开框架库
$ErrorActionPreference = "Continue"

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Personal = Join-Path $RepoDir "personal"
$Date = Get-Date -Format "yyyy-MM-dd HH:mm"

Write-Host "==> 上传个人内容库（私有）"
if (Test-Path (Join-Path $Personal ".git")) {
  git -C $Personal add -A
  git -C $Personal commit -q -m "sync: $Date" 2>$null
  git -C $Personal push
  if ($LASTEXITCODE -eq 0) { Write-Host "OK 个人库已上传" }
  else { Write-Host "  X 个人库 push 失败" }
} else {
  Write-Host "  (无 personal\ 目录，跳过)"
}

Write-Host "==> 上传同步框架（公开）"
git -C $RepoDir add -A
git -C $RepoDir commit -q -m "sync: $Date" 2>$null
git -C $RepoDir push -u origin HEAD
if ($LASTEXITCODE -eq 0) { Write-Host "OK 框架已上传" }
else { Write-Host "  X 框架 push 失败（若远程仓库尚未创建，先到 GitHub 创建 dev-env-sync-template，再双击本脚本即可）" }

Write-Host ""
Write-Host "OK 完成。其他设备双击 deploy.bat 即可同步。"
