# dev-env-sync Windows 一键部署（deploy.bat 调用）
# 拉取公开框架 + 私有内容库，然后部署到本机
$ErrorActionPreference = "Continue"

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Personal = Join-Path $RepoDir "personal"
$UrlFile = Join-Path $RepoDir ".personal-repo"

Write-Host "==> 1/3 更新同步框架（公开库）"
git -C $RepoDir pull --ff-only
if ($LASTEXITCODE -ne 0) { Write-Host "  (框架库更新失败或未配置远程，继续)" }

Write-Host "==> 2/3 更新个人内容库（私有）"
if (Test-Path (Join-Path $Personal ".git")) {
  git -C $Personal pull --ff-only
  if ($LASTEXITCODE -ne 0) { Write-Host "  (个人库更新失败，使用本地版本)" }
} else {
  $url = ""
  if (Test-Path $UrlFile) {
    $url = (Get-Content $UrlFile -Raw).Trim()
  } else {
    $url = Read-Host "首次使用：请输入你的私有内容库地址（如 git@github.com:YOU/private.git）"
    $url = $url.Trim()
    if ($url) { Set-Content -Path $UrlFile -Value $url -Encoding ASCII }
  }
  if ($url) {
    Write-Host "  克隆 $url → personal\"
    git clone $url $Personal
    if ($LASTEXITCODE -ne 0) { Write-Host "X 克隆失败，请检查地址与 GitHub 权限"; exit 1 }
  } else {
    Write-Host "X 缺少个人内容库地址，退出。重跑本脚本再输入即可。"
    exit 1
  }
}

Write-Host "==> 3/3 部署到本机"
& (Join-Path $RepoDir "install.ps1")
