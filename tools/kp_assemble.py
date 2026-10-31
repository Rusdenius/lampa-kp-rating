#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сборка data/<год>.json из чекпоинтов кроулера (crawl_state/*.jsonl).

Формат года: {"v":1, "u":"<дата>", "n":<фильмов с ключом ru>, "f": {"<норм-название>": [рейтинг, idКП, тип, жанры, страны]}}
Ключи: нормализованное русское название + оригинальное (если есть и отличается).
Также: data/ids.json (жанры/страны id->название) и data/manifest.json.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kp_crawl import norm, STATE, DATA

from datetime import date


def main():
    os.makedirs(DATA, exist_ok=True)
    years = {}
    ids = {'genres': {}, 'countries': {}}
    for fn in sorted(os.listdir(STATE)):
        if not fn.endswith('.jsonl'):
            continue
        year = int(fn.replace('year_', '').replace('.jsonl', ''))
        f = {}
        n = 0
        with open(os.path.join(STATE, fn), encoding='utf-8') as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                kid, ru, en, r, typ, gids, cids, yr = rec
                item = [r, kid, typ, gids, cids]
                kru = norm(ru) if ru else ''
                ken = norm(en) if en else ''
                if kru:
                    f[kru] = item
                    n += 1
                if ken and ken != kru:
                    f[ken] = item
        if not f:
            continue
        yf = year  # файл года собираем из записей, отнесённых кроулером к этому году
        out = {'v': 1, 'u': date.today().isoformat(), 'n': n, 'f': f}
        with open(os.path.join(DATA, '%d.json' % yf), 'w', encoding='utf-8') as fh:
            json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
        years[str(yf)] = {'u': out['u'], 'n': n}
        print('%d: %d фильмов, %d ключей' % (yf, n, len(f)))
    with open(os.path.join(DATA, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump({'v': 1, 'u': date.today().isoformat(), 'years': years}, fh,
                  ensure_ascii=False, separators=(',', ':'))
    print('manifest.json: %d годов' % len(years))


if __name__ == '__main__':
    main()
