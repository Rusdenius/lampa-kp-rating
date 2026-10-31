@echo off
rem Обновление базы: последние 3 года (задача KpRatingRefreshRecent, раз в 3 дня)
set PATH=C:\Program Files\Git\cmd;%PATH%
cd /d D:\DEV\lampa-kp-rating
py tools\kp_refresh.py recent >> tools\refresh.log 2>&1
