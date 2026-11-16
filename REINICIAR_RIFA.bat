@echo off
chcp 65001 >nul
title Reiniciar la rifa
cd /d "%~dp0"
echo.
echo   Esto BORRA la base de datos (todos los ganadores) y abre la rifa desde cero.
echo   Los participantes y la cantidad de regalos se vuelven a leer de
echo   participantes.json y config.py.
echo.
choice /c SN /m "  ¿Continuar?"
if errorlevel 2 exit /b
python server.py --reiniciar
pause
