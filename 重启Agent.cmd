@echo off
rem One-click restart of the controlled-machine Agent.
rem Double-click this file; a UAC prompt will appear (Agent runs as admin).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart_agent.ps1" %*
pause
