@echo off
chcp 65001 >nul
echo ========================================================
echo   ASMR 目录 WAV 转 MP3 (320kbps) 本地批量转换工具
echo ========================================================
echo.

where ffmpeg >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未在系统 PATH 中检测到 ffmpeg！
    echo 请先安装 FFmpeg，或者使用 Python 脚本进行转换。
    pause
    exit /b 1
)

set "TARGET_DIR=%~1"
if "%TARGET_DIR%"=="" set "TARGET_DIR=%cd%"

echo 目标转换目录: %TARGET_DIR%
echo 正在递归搜索所有子文件夹中的 .wav 文件并转换为 320kbps MP3...
echo.

for /r "%TARGET_DIR%" %%f in (*.wav) do (
    echo [处理中] %%f
    ffmpeg -y -v warning -i "%%f" -vn -ar 44100 -b:a 320k "%%~dpnf.mp3"
    if exist "%%~dpnf.mp3" (
        del "%%f"
        echo [完成] 已替换为 MP3: %%~dpnf.mp3
    ) else (
        echo [失败] 转换失败，保留原文件: %%f
    )
)

echo.
echo ========================================================
echo   全部 WAV 转换完成！原始大文件已自动清理。
echo ========================================================
pause
