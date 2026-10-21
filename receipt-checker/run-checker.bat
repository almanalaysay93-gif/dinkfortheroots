@echo off
rem Double-click to check pending payment receipts.
cd /d "%~dp0"
python check_receipts.py run
echo.
pause
