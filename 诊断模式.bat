@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Live2D 桌宠 - 诊断模式
echo   启动后屏幕上的宠物窗口会显示：
echo   绿色半透明背景（模型前） + 品红半透明前景（模型后）
echo   4 秒后自动截图到 %%APPDATA%%\live2d-desktop-pet\diag.png
echo ============================================
npm run diag
pause
