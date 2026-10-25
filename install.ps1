# dev-env-sync Windows 一键安装核心（PowerShell）
# 由 deploy.bat 调用，也可单独执行。
# 内容来源：优先 personal\（私有内容库），缺失时用仓库自带示例。
$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OS = "Windows"
$Arch = $env:PROCESSOR_ARCHITECTURE

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "OK $m" -ForegroundColor Green }
function Warn($m) { Write-Host "WARN $m" -ForegroundColor Yellow }

Info "设备环境：$OS / $Arch"

# 内容根目录：personal\（私有库）优先
$ContentRoot = Join-Path $RepoDir "personal"
if (Test-Path $ContentRoot) {
  Info "内容源：personal\（私有内容库）"
} else {
  $ContentRoot = $RepoDir
  Warn "未检测到 personal\，使用仓库自带示例内容（正式部署请先配置私人库，见 README）"
}

# ---------- 1. Copilot skills 与全局指令 ----------
# 技能可在 SKILL.md frontmatter 声明 platforms: [darwin] / os: windows；
# 不属于当前系统的技能跳过，不落盘。
function Get-SkillPlatforms($dir) {
  $file = Join-Path $dir "SKILL.md"
  if (-not (Test-Path $file)) { return "" }
  $lines = Get-Content $file -TotalCount 40
  if ($lines.Count -lt 2 -or $lines[0].Trim() -ne "---") { return "" }
  for ($i = 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq "---") { break }
    if ($lines[$i] -match '^(?i)\s*(platforms|os)\s*:\s*(.+)$') {
      return $Matches[2].ToLower().Replace("[", "").Replace("]", "").Replace('"', "")
    }
  }
  return ""
}

function Test-SkillAllowed($dir) {
  $list = Get-SkillPlatforms $dir
  if ([string]::IsNullOrWhiteSpace($list)) { return $true }
  foreach ($v in ($list -split '[, ]+' | Where-Object { $_ })) {
    $name = $v.Trim()
    if ($name -eq "macos" -or $name -eq "mac" -or $name -eq "osx") { $name = "darwin" }
    if ($name -eq "windows" -or $name -eq "win") { $name = "win32" }
    if ($name -eq "win32") { return $true }
  }
  return $false
}

$skillsSrc = Join-Path $ContentRoot "copilot\skills"
$skillsDst = Join-Path $env:USERPROFILE ".copilot\skills"
if (Test-Path $skillsSrc) {
  Info "部署 Copilot skills"
  New-Item -ItemType Directory -Force -Path $skillsDst | Out-Null
  Get-ChildItem -Path $skillsSrc -Directory | ForEach-Object {
    if (-not (Test-SkillAllowed $_.FullName)) {
      Warn "跳过技能 $($_.Name)（仅 $(Get-SkillPlatforms $_.FullName) 可用）"
      return
    }
    # 只覆盖私有库里存在的技能：本机独有技能与隐藏文件保留
    $target = Join-Path $skillsDst $_.Name
    Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -Path $_.FullName -Destination $target -Recurse -Force
  }
  $ghDir = Join-Path $env:USERPROFILE ".github"
  New-Item -ItemType Directory -Force -Path $ghDir | Out-Null
  $instr = Join-Path $ContentRoot "copilot\copilot-instructions.md"
  if (Test-Path $instr) { Copy-Item $instr $ghDir -Force }
  Ok "skills 与全局指令部署完成"
} else {
  Warn "未找到 skills 目录，跳过"
}

# ---------- 2. winget 工具链 ----------
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Warn "未找到 winget。请先安装 App Installer：https://aka.ms/getwinget 后重跑"
} else {
    $pkgsFile = Join-Path $ContentRoot "tools\winget\packages.txt"
    if (Test-Path $pkgsFile) {
      Get-Content $pkgsFile | Where-Object { $_ -and -not $_.TrimStart().StartsWith("#") } | ForEach-Object {
          $p = $_.Trim()
          if ($p) {
              Info "winget install $p"
              winget install -e --id $p --silent --accept-package-agreements --accept-source-agreements
          }
      }
    }

    # C++ 工具链：VS 2022 Build Tools（MSVC 编译 Rust/C++ 原生模块需要，体积较大）
    Info "安装 Visual Studio 2022 Build Tools（C++ 工具链）"
    winget install -e --id Microsoft.VisualStudio.2022.BuildTools `
        --silent --accept-package-agreements --accept-source-agreements `
        --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    Ok "winget 清单完成"
}

# ---------- 3. npm 全局包 ----------
if (Get-Command npm -ErrorAction SilentlyContinue) {
    $glFile = Join-Path $ContentRoot "tools\npm-globals.txt"
    if (Test-Path $glFile) {
      Info "安装 npm 全局包（清单：$glFile）"
      Get-Content $glFile | Where-Object { $_ -and -not $_.TrimStart().StartsWith("#") } | ForEach-Object {
          $p = $_.Trim()
          if ($p) { npm install -g $p }
      }
      Ok "npm 全局包完成"
    }
} else {
    Warn "未找到 npm（Node 可能刚安装完），重开终端后重跑 deploy.bat 即可"
}

Write-Host ""
Ok "全部完成。重启 VS Code 后生效。"
