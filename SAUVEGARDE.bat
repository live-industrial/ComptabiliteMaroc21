@echo off
cd /d "%~dp0"
if not exist backups mkdir backups
copy /Y database\comptabilite.sqlite backups\comptabilite-manuel-%date:~-4%%date:~3,2%%date:~0,2%.sqlite
echo Sauvegarde terminee si la base existe.
pause
