"""Обновление базы рейтингов (для планировщика задач).

Режимы:
  recent — пересобрать последние 3 года, пуш (раз в 3 дня)
  full   — пересбор всей базы, сборка, пуш (раз в год)

Запуск: python kp_refresh.py recent|full
Лог: tools/refresh.log
"""
import datetime
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LOG = os.path.join(HERE, 'refresh.log')


def log(msg):
    line = '[%s] %s' % (datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'), msg)
    print(line, flush=True)
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(line + '\n')


def run(cmd):
    log('$ ' + ' '.join(str(c) for c in cmd))
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    if r.stdout:
        log(r.stdout.strip()[-1500:])
    if r.stderr:
        log('STDERR: ' + r.stderr.strip()[-1500:])
    if r.returncode:
        raise RuntimeError('команда завершилась с кодом %d' % r.returncode)
    return r


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'recent'
    today = datetime.date.today()

    if mode == 'recent':
        # последние 3 года (текущий и два предыдущих)
        years = ','.join(str(today.year - i) for i in range(3))
        run([sys.executable, os.path.join(HERE, 'kp_crawl.py'),
             '--refresh', '--years=' + years])
    elif mode == 'full':
        run([sys.executable, os.path.join(HERE, 'kp_crawl.py'), '--refresh'])
    else:
        log('неизвестный режим: ' + mode)
        return 1

    run([sys.executable, os.path.join(HERE, 'kp_assemble.py')])

    run(['git', 'add', '-f', 'data/'])
    st = run(['git', 'status', '--porcelain', 'data/'])
    if st.stdout.strip():
        run(['git', 'commit', '-m',
             'data: обновление базы (%s) %s' % (mode, today.isoformat())])
        run(['git', 'push', 'origin', 'main'])
        log('база обновлена и запушена (режим %s)' % mode)
    else:
        log('изменений нет — пушить нечего (режим %s)' % mode)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        log('ОШИБКА: ' + str(e))
        sys.exit(1)
