@echo off
chcp 65001 >nul
title Gran Rifa
cd /d "%~dp0"
python server.py
pause
