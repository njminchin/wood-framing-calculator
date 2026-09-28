@echo off
cd /d "%~dp0"
title Floating Frame Calculator
python server.py
if errorlevel 1 pause
