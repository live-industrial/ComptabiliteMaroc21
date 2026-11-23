@echo off
cd /d "%~dp0"
echo ATTENTION : arretez d abord le serveur Node.js.
set /p FILE=Nom du fichier dans backups : 
if exist "backups\%FILE%" (copy /Y "backups\%FILE%" database\comptabilite.sqlite & echo Restauration terminee.) else (echo Fichier introuvable.)
pause
