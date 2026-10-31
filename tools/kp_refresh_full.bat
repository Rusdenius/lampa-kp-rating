@echo off
rem Полное обновление базы: все годы (задача KpRatingRefreshFull, раз в год)
set PATH=C:\Program Files\Git\cmd;%PATH%
cd /d D:\DEV\lampa-kp-rating
py tools\kp_refresh.py full >> tools\refresh.log 2>&1
