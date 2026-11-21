@echo off
REM ============================================================
REM  Essay Reader - publish to the phone in one step
REM
REM  Runs a static server on your Wi-Fi network so the phone can
REM  open the app, install it to the home screen, and then keep
REM  working with the computer switched off.
REM
REM  Requirements: Node.js installed, phone and PC on the same Wi-Fi.
REM ============================================================

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

echo.
echo Starting Essay Reader on your local network...
echo.
echo   Open the address printed below on your phone's browser.
echo   Then use the browser menu and choose "Add to Home Screen".
echo   After it loads once, the app works with this computer turned off.
echo.
echo Press Ctrl+C to stop.
echo.

node tools\serve-phone.mjs

endlocal
pause
