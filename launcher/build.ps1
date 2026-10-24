# Builds "Chess Review.exe" (the desktop launcher) with the .NET Framework compiler that ships with Windows.
$root = Split-Path -Parent $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /optimize+ `
  "/win32icon:$root\assets\icon.ico" `
  "/out:$root\Chess Review.exe" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  "$root\launcher\Launcher.cs"
