#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Кроулер каталога Кинопоиска по годам -> статическая база рейтингов (плагин Lampa).

Обходит каталог Кинопоиска (MovieDesktopListPage) год за годом: 2029 -> 1890.
На каждый фильм: id КП, русское/оригинальное название, рейтинг КП, тип (фильм/сериал),
жанры (id), страны (id). Чекпоинты в crawl_state/ — запуск можно прерывать и продолжать.

Темп: ~1.5-2 запроса/с (3 воркера), бэкофф на 429/5xx, ретраи страниц.
"""
import json
import os
import queue
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STATE = os.path.join(ROOT, 'crawl_state')
DATA = os.path.join(ROOT, 'data')
BODY = os.path.join(HERE, 'catalog_body.json')

URL = 'https://graphql.kinopoisk.ru/graphql/?operationName=MovieDesktopListPage'
HDRS = {
    'Content-Type': 'application/json',
    'service-id': '25',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
}
WORKERS = 3
SLEEP = (0.5, 0.9)          # пауза между страницами одного воркера, с
PAGE_LIMIT = 50
YEAR_MIN, YEAR_MAX = 1890, 2029

with open(BODY, encoding='utf-8') as f:
    TEMPLATE = json.load(f)

PUNCT = re.compile(r'[\.,:;!?\(\)\[\]—–\-_/\\]+')
QUOTES = re.compile(r'[«»"\']')
SPACES = re.compile(r'\s+')


def norm(s):
    """Нормализация названий — ПОБАЙТОВО как norm() в плагине kp-rating.js."""
    s = (s or '').lower()
    s = QUOTES.sub('', s)
    s = PUNCT.sub(' ', s)
    return SPACES.sub(' ', s).strip()


def gql(year, offset, timeout=30):
    body = json.loads(json.dumps(TEMPLATE))
    body['variables']['moviesOffset'] = offset
    body['variables']['filters']['singleSelectFilterValues'] = [
        {'filterId': 'year', 'value': str(year)}]
    req = urllib.request.Request(
        URL, data=json.dumps(body).encode('utf-8'), headers=HDRS, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def meta_path(year):
    return os.path.join(STATE, 'year_%d.meta.json' % year)


def jsonl_path(year):
    return os.path.join(STATE, 'year_%d.jsonl' % year)


def load_meta(year):
    try:
        with open(meta_path(year), encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def save_meta(year, meta):
    with open(meta_path(year), 'w', encoding='utf-8') as f:
        json.dump(meta, f)


class YearFailed(Exception):
    pass


def fetch_page(year, offset):
    backoffs = [30, 60, 120]
    for attempt in range(4):
        try:
            return gql(year, offset)
        except urllib.error.HTTPError as e:
            code = e.code
            print('  [%d] HTTP %d (offset %d)' % (year, code, offset), flush=True)
            if code in (429, 403):
                time.sleep(backoffs[min(attempt, 2)] * 2)
            elif 500 <= code < 600:
                time.sleep(backoffs[min(attempt, 2)])
            else:
                raise YearFailed('HTTP %d' % code)
        except Exception as e:
            print('  [%d] сетевая ошибка: %s' % (year, str(e)[:120]), flush=True)
            time.sleep(backoffs[min(attempt, 2)])
    raise YearFailed('страница offset=%d не даётся' % offset)


def parse_item(it, filter_year):
    mv = it.get('movie') or {}
    kid = mv.get('id')
    if not kid:
        return None
    title = mv.get('title') or {}
    ru = title.get('russian')
    en = title.get('original')
    if not ru and not en:
        return None
    typ = 0 if (mv.get('__typename') == 'Film') else 1
    # год фильма/старта сериала
    yr = mv.get('productionYear')
    if not yr:
        ry = (mv.get('releaseYears') or [{}])[0] or {}
        yr = ry.get('start') or 0
    if not yr:
        yr = filter_year
    rk = (mv.get('rating') or {}).get('kinopoisk') or {}
    r = rk.get('value') or 0
    if rk.get('isActive') is False:
        r = 0
    gids = [g.get('id') for g in (mv.get('genres') or []) if g.get('id') is not None]
    cids = [c.get('id') for c in (mv.get('countries') or []) if c.get('id') is not None]
    return [kid, ru, en, r, typ, gids, cids, yr]


def crawl_year(year):
    meta = load_meta(year)
    if meta.get('done'):
        return None
    offset = int(meta.get('next_offset', 0))
    total = meta.get('total')
    n = 0
    with open(jsonl_path(year), 'a', encoding='utf-8') as out:
        while True:
            page = fetch_page(year, offset)
            m = (page.get('data') or {}).get('movieListBySlug', {}).get('movies') or {}
            total = m.get('total') or 0
            items = m.get('items') or []
            if total == 0:
                meta.update({'done': True, 'total': 0, 'next_offset': 0})
                save_meta(year, meta)
                return 0
            for it in items:
                rec = parse_item(it, year)
                if rec:
                    out.write(json.dumps(rec, ensure_ascii=False, separators=(',', ':')) + '\n')
                    n += 1
            offset += len(items)
            meta.update({'total': total, 'next_offset': offset})
            save_meta(year, meta)
            if offset >= total or not items:
                break
            time.sleep(random.uniform(*SLEEP))
    meta['done'] = True
    save_meta(year, meta)
    print('[%d] готово: %d позиций (total=%s)' % (year, offset, total), flush=True)
    return total


def worker(q, failed, lock):
    while True:
        try:
            year = q.get_nowait()
        except queue.Empty:
            return
        try:
            t0 = time.time()
            total = crawl_year(year)
            if total is not None:
                with lock:
                    print('== %d: %s позиций за %.0f с' %
                          (year, total, time.time() - t0), flush=True)
        except YearFailed as e:
            with lock:
                failed.append(year)
                print('!! %d: %s — год отложен, перезапусти кроулер позже' % (year, e), flush=True)
        finally:
            q.task_done()


def main():
    os.makedirs(STATE, exist_ok=True)
    os.makedirs(DATA, exist_ok=True)
    years = list(range(YEAR_MAX, YEAR_MIN - 1, -1))
    q = queue.Queue()
    for y in years:
        q.put(y)
    failed = []
    lock = threading.Lock()
    t0 = time.time()
    threads = [threading.Thread(target=worker, args=(q, failed, lock)) for _ in range(WORKERS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    print('Обход завершён за %.0f с; проблемных годов: %d %s' %
          (time.time() - t0, len(failed), failed if failed else ''), flush=True)


if __name__ == '__main__':
    main()
