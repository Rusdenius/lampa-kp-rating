/**
 * Lampa плагин «Кинопоиск рейтинг» v1.5.1
 * Заменяет рейтинг TMDB на карточках рейтингом Кинопоиска.
 *
 * ВАЖНО (v1.3.0): в реальном клиенте Lampa (3.4.4) событие request_secuses
 * приходит как { params, data } БЕЗ abort() и срабатывает синхронно ДО
 * params.complite(data). Поэтому архитектура такая:
 *  1) request_secuses: мгновенно подменяем vote_average у карточек, чей рейтинг
 *     уже в кеше (штатная отрисовка рисует Кинопоиск), и регистрируем все
 *     карточки в реестре «название+год → фильм».
 *  2) Для карточек без кеша — фоновый поиск в API Кинопоиска; когда рейтинг
 *     получен, допатчиваем УЖЕ отрисованные бейджи .card__vote в DOM
 *     (сопоставление карточки с фильмом по .card__title + .card__age).
 *  3) MutationObserver: новые карточки — сразу патчим, если рейтинг уже известен;
 *     если карточка не из нашего реестра — ищем по названию и году прямо из DOM.
 *
 * Источники (Настройки → Кинопоиск → Источник API):
 *  — kinopoisk.ru (по умолчанию): официальный GraphQL Кинопоиска, БЕЗ ключа.
 *    Только POST, запрос встроен байт-точно (сервер работает по allow-list).
 *  — kinopoiskapiunofficial.tech: бесплатный ключ, ~500 запросов/день.
 *  — api.poiskkino.dev: бесплатный ключ, ~5 запросов/день (последний рубеж).
 *
 * Сеть: на Android-приложении — нативный мост Android.httpReq (без CORS),
 * в браузере — $.ajax (graphql на чужом Origin получит 403, используйте keyed-API).
 *
 * Цвета как на Кинопоиске: 7 и выше — зелёный (#3cbb5f), ниже 7 — светло-серый (#cfcfcf).
 * Если фильма нет в Кинопоиске — на бейдже показывается символ «–» вместо рейтинга TMDB.
 * Периодическое обновление: найденные значения старше 3 дней тихо перезапрашиваются в фоне
 * (показывается сразу из кеша, свежее значение подставляется по приходу ответа).
 * Ошибки сети/сервиса не считаются «не найдено»: кеш не портится, символ «–» не ставится,
 * повтор поиска произойдёт при следующем просмотре.
 * Страница фильма: если включено, ставится нативный бейдж «KP» (поле kp_rating)
 * из кеша — обычно рейтинги на странице фильма уже показывает другой плагин.
 */
(function (global) {
  'use strict';

  var VERSION = '1.5.1';

  var CACHE_PREFIX = 'kpr13_';
  var CACHE_TTL = 60 * 60 * 24 * 30;    // 30 дней — абсолютный потолок записи
  var CACHE_TTL_NEG = 60 * 60 * 24;     // сутки для «не найдено»
  var REFRESH_AFTER = 60 * 60 * 24 * 3; // 3 дня — фоновое обновление найденного
  var MAX_PARALLEL = 3;
  var REQUEST_TIMEOUT = 8000;

  var SRC = {
    kp: 'kinopoisk.ru',
    kpu: 'kinopoiskapiunofficial.tech',
    kpd: 'api.poiskkino.dev'
  };
  var KEY = {
    source: 'kpr_source',
    key: 'kpr_apikey',
    replace: 'kpr_replace',
    in_full: 'kpr_in_full',
    colors: 'kpr_colors',
    debug: 'kpr_debug'
  };

  var GQL_URL = 'https://graphql.kinopoisk.ru/graphql';
  // Точный текст запроса SuggestSearch (allow-list сервера требует байт-в-байт).
  var GQL_QUERY = 'query SuggestSearch($keyword: String!, $yandexCityId: Int, $limit: Int) {\n  suggest(keyword: $keyword) {\n    top(yandexCityId: $yandexCityId, limit: $limit) {\n      topResult {\n        global {\n          ...SuggestMovieItem\n          ...SuggestPersonItem\n          ...SuggestCinemaItem\n          ...SuggestMovieListItem\n          __typename\n        }\n        __typename\n      }\n      movies {\n        movie {\n          ...SuggestMovieItem\n          __typename\n        }\n        __typename\n      }\n      persons {\n        person {\n          ...SuggestPersonItem\n          __typename\n        }\n        __typename\n      }\n      cinemas {\n        cinema {\n          ...SuggestCinemaItem\n          __typename\n        }\n        __typename\n      }\n      movieLists {\n        movieList {\n          ...SuggestMovieListItem\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment ShortImage on Image {\n  avatarsUrl\n  fallbackUrl\n  __typename\n}\n\nfragment MovieHdVerticalPoster on Movie {\n  gallery {\n    posters {\n      hdVertical: vertical(override: OTT_WHEN_EXISTS) {\n        ...ShortImage\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  __typename\n}\n\nfragment MovieKpVerticalPoster on Movie {\n  gallery {\n    posters {\n      kpVertical: vertical {\n        ...ShortImage\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  __typename\n}\n\nfragment TicketOption on Movie {\n  ticketOption {\n    purchasable\n    releaseAnnounce {\n      available\n      releaseDate {\n        accuracy\n        date\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  __typename\n}\n\nfragment SuggestMovieItem on Movie {\n  id\n  contentId\n  title {\n    russian\n    original\n    __typename\n  }\n  rating {\n    kinopoisk {\n      isActive\n      value\n      __typename\n    }\n    __typename\n  }\n  ...MovieHdVerticalPoster\n  ...MovieKpVerticalPoster\n  viewOption {\n    buttonText\n    isAvailableOnline: isWatchable(filter: {anyDevice: false, anyRegion: false})\n    purchasabilityStatus\n    contentPackageToBuy {\n      billingFeatureName\n      __typename\n    }\n    subscriptionBadge {\n      image {\n        avatarsUrl\n        __typename\n      }\n      __typename\n    }\n    type\n    availabilityAnnounce {\n      groupPeriodType\n      announcePromise\n      availabilityDate\n      type\n      __typename\n    }\n    __typename\n  }\n  ...TicketOption\n  ... on Film {\n    productionYear\n    __typename\n  }\n  ... on TvSeries {\n    releaseYears {\n      end\n      start\n      __typename\n    }\n    __typename\n  }\n  ... on TvShow {\n    releaseYears {\n      end\n      start\n      __typename\n    }\n    __typename\n  }\n  ... on MiniSeries {\n    releaseYears {\n      end\n      start\n      __typename\n    }\n    __typename\n  }\n  __typename\n}\n\nfragment SuggestPersonItem on Person {\n  id\n  name\n  originalName\n  birthDate\n  poster {\n    avatarsUrl\n    fallbackUrl\n    __typename\n  }\n  __typename\n}\n\nfragment SuggestCinemaItem on Cinema {\n  id\n  ctitle: title\n  city {\n    id\n    name\n    geoId\n    __typename\n  }\n  __typename\n}\n\nfragment SuggestMovieListItem on MovieListMeta {\n  id\n  cover {\n    avatarsUrl\n    __typename\n  }\n  coverBackground {\n    avatarsUrl\n    __typename\n  }\n  name\n  url\n  description\n  movies(limit: 0) {\n    total\n    __typename\n  }\n  __typename\n}';

  /* ================= состояние ================= */

  var queue = [];
  var active = 0;
  var paused = false;      // пауза после 401/402 (ключевые API)
  var warned = false;      // «нет ключа» показано один раз
  var gqlBlocked = false; // сервер отклонил запрос (allow-list сменился)
  var netWarned = false; // «нет ответа kinopoisk.ru» показано один раз
  var fullMarks = typeof WeakSet == 'function' ? new WeakSet() : null;

  // Реестр фильмов сессии: по TMDB id и по нормализованному названию.
  var regById = {};     // tmdbId -> entry
  var regByTitle = {};  // normTitle -> [entry]
  var regByKey = {};    // ключ поиска ('i<id>' | 't<title>|<year>') -> entry
  var inflight = {};    // ключ поиска -> true, запрос в полёте

  function regEntry(id, title, year) {
    var e = regById[id];
    if (!e) {
      var t = norm(title);
      // дедупликация: тот же фильм уже зарегистрирован (по названию+году) —
      // используем существующую запись (иначе resolveCard увидит «неоднозначность»)
      if (t) {
        var dup = regByTitle[t];
        if (dup) {
          for (var i = 0; i < dup.length; i++) {
            if (dup[i].year == (year || 0)) { e = dup[i]; regById[id] = e; return e; }
          }
        }
      }
      e = { id: id, title: title, year: year || 0, r: 0, v: 0, done: false };
      regById[id] = e;
      if (t) {
        var list = regByTitle[t] || (regByTitle[t] = []);
        list.push(e);
      }
    }
    return e;
  }

  function keyOfId(id) { return 'i' + id; }
  function keyOfTitle(title, year) { return 't' + norm(title) + '|' + (year || 0); }

  /* ================= окружение ================= */

  function Lampa() { return global.Lampa; }
  function storage() { return Lampa() && Lampa().Storage; }

  function field(name, def) {
    try {
      var v = storage().field(name);
      return v === undefined || v === null || v === '' ? def : v;
    } catch (e) { return def; }
  }

  function source() { return field(KEY.source, SRC.kp); }

  function debugOn() { return !!field(KEY.debug, false); }

  function dbg() {
    if (!debugOn()) return;
    try {
      var msg = Array.prototype.slice.call(arguments).join(' ');
      console.log('[KPR]', msg);
    } catch (e) {}
  }

  function enabled() {
    if (paused) return false;
    if (!field(KEY.replace, true)) return false;
    if (source() != SRC.kp && !field(KEY.key, '')) {
      if (!warned) {
        warned = true;
        try { Lampa().Noty.show('Плагин «Кинопоиск»: укажите API-ключ в Настройки → Кинопоиск'); } catch (e) {}
      }
      return false;
    }
    return true;
  }

  function pause401() {
    paused = true;
    try { Lampa().Noty.show('Плагин «Кинопоиск»: API-ключ отклонён (401/402). Проверьте ключ в Настройках'); } catch (e) {}
  }

  /* ================= сеть ================= */

  // opts: { method:'GET'|'POST', body:String, headers:{} }
  function net(url, opts, done) {
    opts = opts || {};
    var finished = false;
    function fin(data, err) {
      if (finished) return;
      finished = true;
      done(data, err);
    }
    var timer = setTimeout(function () { fin(null, { timeout: true }); }, REQUEST_TIMEOUT);

    var params = {
      url: url,
      dataType: 'json',
      headers: opts.headers || {}
    };
    // нативный мост определяет метод по наличию post_data (без него — GET → 404)
    if (opts.body) params.post_data = opts.body;

    var call = {
      complite: function (data) { clearTimeout(timer); fin(data); },
      error: function (e) {
        clearTimeout(timer);
        var status = 0;
        try { status = (e && e.status) || 0; } catch (er) {}
        try { if (!status && e && e.getResponseHeader) status = e.status || 0; } catch (er) {}
        if (status == 401 || status == 402) pause401();
        dbg('net error', url, status);
        fin(null, { status: status || 0 });
      }
    };

    // нативный мост приложения: без CORS, поддерживает POST (тело — строка в params.post_data)
    var A = Lampa() && Lampa().Android;
    if (A && typeof A.httpReq == 'function' && global.AndroidJS) {
      dbg('net native', params.post_data ? 'POST' : 'GET', url);
      A.httpReq(params, call);
      return;
    }

    // фолбэк: браузер (для keyed-API; graphql на чужом Origin получает 403)
    if (global.$ && global.$.ajax) {
      global.$.ajax({
        url: url,
        type: params.post_data ? 'POST' : 'GET',
        headers: params.headers,
        data: params.post_data,
        timeout: REQUEST_TIMEOUT,
        dataType: 'json',
        success: function (d) { call.complite(d); },
        error: function (x) { call.error(x); }
      });
      return;
    }

    clearTimeout(timer);
    fin(null, { nosupport: true });
  }

  function enqueue(task) {
    queue.push(task);
    pump();
  }

  function pump() {
    while (active < MAX_PARALLEL && queue.length) {
      var task = queue.shift();
      active++;
      task(function () {
        active--;
        pump();
      });
    }
  }

  /* ================= кеш ================= */

  function cacheGet(key) {
    try {
      var raw = global.localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      var c = JSON.parse(raw);
      var ttl = (c.r > 0 ? CACHE_TTL : CACHE_TTL_NEG) * 1000; // сек -> мс
      if (!c.t || Date.now() - c.t > ttl) return null;
      return c;
    } catch (e) { return null; }
  }

  function cacheSet(key, c) {
    try { global.localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(c)); } catch (e) {}
  }

  /* ================= матчинг ================= */

  function norm(s) {
    return (s || '').toString().toLowerCase()
      .replace(/[«»"']/g, '')
      .replace(/[\.,:;!?\(\)\[\]—–\-_/\\]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function yearOf(item) {
    return parseInt(((item.release_date || item.first_air_date || item.year || '') + '').slice(0, 4), 10) || 0;
  }

  function titleOf(item) {
    return item.title || item.name || item.original_title || item.original_name || '';
  }

  // film: { nameRu, nameEn, year }
  function score(tmdbTitle, tmdbYear, film) {
    var s = 0;
    var names = [];
    if (film.nameRu) names.push(norm(film.nameRu));
    if (film.nameEn) names.push(norm(film.nameEn));
    var t = norm(tmdbTitle);
    for (var i = 0; i < names.length; i++) {
      if (names[i] && t) {
        if (names[i] == t) { s += 6; break; }
        if (names[i].indexOf(t) == 0 || t.indexOf(names[i]) == 0) s += 3;
      }
    }
    var ky = parseInt((film.year || 0) + '', 10) || 0;
    if (tmdbYear && ky) {
      var d = Math.abs(tmdbYear - ky);
      if (d == 0) s += 4; else if (d == 1) s += 2; else if (d > 3) s -= 4;
    }
    return s;
  }

  /* ================= источники ================= */

  // candidate: { film:{nameRu,nameEn,year}, rating, votes, active }

  function candGql(m) {
    var t = m.title || {};
    var rk = (m.rating && m.rating.kinopoisk) || {};
    var year = m.productionYear || (m.releaseYears && m.releaseYears[0] && m.releaseYears[0].start) || 0;
    return { film: { nameRu: t.russian, nameEn: t.original, year: year }, rating: rk.value, votes: 0, active: rk.isActive !== false };
  }

  function pick(cands, done) {
    var best = null, bestScore = 0;
    cands.forEach(function (c) {
      var sc = score(titleOf(c.item), yearOf(c.item), c.film);
      if (sc > bestScore) { bestScore = sc; best = c; }
    });
    if (best && bestScore >= 6 && best.active !== false) {
      var r = parseFloat(best.rating) || 0;
      done(Math.round(r * 10) / 10, best.votes || 0);
    } else {
      done(0); // не нашли — негативный кеш
    }
  }

  function kpRating(item, done) {
    var title = titleOf(item);
    if (!title) return done(0);
    var src = source();

    if (src == SRC.kp) {
      if (gqlBlocked) return done(undefined); // сервис недоступен — не «не найдено»
      net(GQL_URL, {
        method: 'POST',
        body: JSON.stringify({ operationName: 'SuggestSearch', variables: { keyword: title, limit: 20 }, query: GQL_QUERY }),
        headers: { 'Content-Type': 'application/json', 'service-id': '25' }
      }, function (data, err) {
        if (err || !data || data.errors) {
          if (data && data.errors && !gqlBlocked) {
            gqlBlocked = true;
            try { Lampa().Noty.show('Плагин «Кинопоиск»: сервис отклонил запрос — обновите плагин'); } catch (e) {}
          }
          if (err && !data && !netWarned) {
            netWarned = true; // сеть не дошла (мост/таймаут) — видимая диагностика
            try { Lampa().Noty.show('Плагин «Кинопоиск»: нет ответа kinopoisk.ru (код ' + ((err && err.status) || 0) + ')'); } catch (e) {}
          }
          dbg('gql fail', (err && err.status) || 'errors', title);
          return done(undefined); // ошибка сети ≠ «не найдено»: кеш и бейдж не трогаем
        }
        var top = (data.data && data.data.suggest && data.data.suggest.top) || {};
        var cands = [];
        var tr = top.topResult && top.topResult.global;
        if (tr) cands.push(candGql(tr));
        (top.movies || []).forEach(function (m) {
          if (m && m.movie) cands.push(candGql(m.movie));
        });
        cands.forEach(function (c) { c.item = item; });
        pick(cands, done);
      });
    } else if (src == SRC.kpd) {
      net('https://api.poiskkino.dev/v1.4/movie/search?limit=10&page=1&query=' + encodeURIComponent(title),
        { headers: { 'X-API-KEY': field(KEY.key, '') } },
        function (data, err) {
          if (err || !data) return done(undefined); // ошибка сети ≠ «не найдено»
          var cands = [];
          ((data && data.docs) || []).forEach(function (d) {
            cands.push({ item: item, film: { nameRu: d.name, nameEn: d.alternativeName, year: d.year }, rating: d.rating && (d.rating.kp || d.rating.kinopoisk), votes: d.rating && (d.rating.kpVote || d.rating.kinopoiskVoteCount), active: true });
          });
          pick(cands, done);
        });
    } else { // kinopoiskapiunofficial.tech
      net('https://kinopoiskapiunofficial.tech/api/v2.1/films/search-by-keyword?keyword=' + encodeURIComponent(title),
        { headers: { 'X-API-KEY': field(KEY.key, '') } },
        function (data, err) {
          if (err || !data) return done(undefined); // ошибка сети ≠ «не найдено»
          var cands = [];
          var films = (data && data.films) || (data && data.searchFilms && data.searchFilms.films) || [];
          films.forEach(function (f) {
            cands.push({ item: item, film: { nameRu: f.nameRu, nameEn: f.nameEn, year: parseInt(f.year, 10) || 0 }, rating: f.ratingKinopoisk || f.rating || (f.rating && f.rating.kp), votes: f.ratingKinopoiskVoteCount || (f.rating && f.rating.kpVote), active: true });
          });
          pick(cands, done);
        });
    }
  }

  /* ================= поиск по ключу ================= */

  // item: { id?, title, year } ; key: 'i<id>' | 't<title>|<year>'
  function lookup(item, key) {
    if (inflight[key]) return;
    var e = regByKey[key];
    if (e && e.done) return;
    var c = cacheGet(key);
    if (c) {
      if (e) { e.r = c.r; e.v = c.v || 0; e.done = true; }
      dbg('cache hit', key, c.r);
      patchCards();
      // периодическое обновление: запись старше REFRESH_AFTER — обновим в фоне
      if (c.t && c.r > 0 && Date.now() - c.t > REFRESH_AFTER * 1000) fetchAndStore(item, key);
      return;
    }
    fetchAndStore(item, key);
  }

  // фоновый поиск + сохранение в кеш; по завершении допатчиваем DOM.
  // done(rating): rating>0 — найдено; 0 — подтверждённо не найдено (символ «–»);
  // undefined — ошибка сети/сервиса: кеш не портим, бейдж не трогаем, повторим позже.
  function fetchAndStore(item, key) {
    if (inflight[key]) return;
    inflight[key] = true;
    dbg('fetch', key, item.title);
    enqueue(function (next) {
      kpRating(item, function (rating, votes) {
        delete inflight[key];
        if (rating === undefined || rating === null) {
          dbg('skip (error)', key, 'кеш и бейдж не тронуты');
          next();
          return;
        }
        if (rating === 0) {
          var prev = cacheGet(key);
          if (prev && prev.r > 0) {
            // раньше рейтинг был найден, теперь «пусто» — вероятен ложный пропуск
            // (suggest отдал пустой ответ). Хорошую запись не затираем, «–» не ставим;
            // старый t сохранён — обновление повторится при следующем просмотре.
            dbg('keep previous rating', key, prev.r);
            next();
            return;
          }
        }
        cacheSet(key, { r: rating || 0, v: votes || 0, t: Date.now() });
        var e = regByKey[key];
        if (e) { e.r = rating || 0; e.v = votes || 0; e.done = true; }
        dbg('done', key, rating);
        patchCards(); // и найденное (число), и подтверждённое «не найдено» (символ «–»)
        next();
      });
    });
  }

  /* ================= применение к данным (до отрисовки) ================= */

  function isPatchable(item) {
    return item && typeof item == 'object'
      && (item.poster_path || item.backdrop_path || item.release_date || item.first_air_date)
      && typeof item.vote_average != 'undefined';
  }

  function isFull(item) {
    return fullMarks && fullMarks.has(item);
  }

  // подмена рейтинга в данных: карточкам — vote_average (рисует штатный шаблон),
  // странице фильма — нативный бейдж «KP» (kp_rating), бейдж «TMDB» скрывается сам (vote_average = 0)
  function applyItem(item, rating) {
    if (!(rating > 0)) return;
    if (isFull(item)) {
      item.kp_rating = rating;
      item.vote_average = 0;
    } else {
      item.vote_average = rating;
    }
  }

  /* ================= хук ответов (до отрисовки) ================= */

  function onSecuses(e) {
    try {
      if (!enabled()) return;
      var url = (e.params && e.params.url || '') + '';
      var tmdbUrl = /api\.themoviedb\.org|tmdb\./i.test(url);
      if (!tmdbUrl) {
        // ответ НЕ из TMDB: берём только если это очень похоже на TMDB-список
        // (пользовательский прокси в настройках Lampa может менять домен)
        var d0 = e.data;
        if (!(d0 && Array.isArray(d0.results) && d0.results.length && isPatchable(d0.results[0]))) return;
      }
      if (/kinopoisk|poiskkino/i.test(url)) return;

      var data = e.data;
      if (!data || typeof data != 'object') return;

      var items = [];
      if (Array.isArray(data.results)) {
        data.results.forEach(function (it) { if (isPatchable(it)) items.push(it); });
      } else if (data.id && (data.title || data.name) && !Array.isArray(data.results)) {
        if (field(KEY.in_full, false) && (data.overview || data.poster_path)) {
          if (fullMarks) fullMarks.add(data); // страница фильма: включить нативный бейдж «KP»
          items.push(data);
        }
      }
      if (!items.length) return;

      items.forEach(function (item) {
        var title = titleOf(item);
        var year = yearOf(item);
        var en = regEntry(item.id, title, year);
        var key = keyOfId(item.id);
        if (regByKey[key] != en) regByKey[key] = en;
        var c = cacheGet(key);
        if (c) {
          en.r = c.r; en.v = c.v || 0; en.done = true;
          applyItem(item, c.r);
          // периодическое обновление: запись старше REFRESH_AFTER — тихо перезапросить
          if (c.r > 0 && c.t && Date.now() - c.t > REFRESH_AFTER * 1000) {
            fetchAndStore({ id: item.id, title: title, year: year }, key);
          }
        } else {
          // карточки без кеша: фоновый поиск; когда придёт ответ — допатчим DOM
          lookup({ id: item.id, title: title, year: year }, key);
        }
      });
    } catch (err) {
      // ничего не ломаем
    }
  }

  /* ================= цвета (палитра Кинопоиска) ================= */

  var KP_GREEN = '#3cbb5f'; // зелёный Кинопоиска
  var KP_GRAY = '#cfcfcf';  // светло-серый (поднял яркость: прежний #9e9e9e был плохо различим)
  var KP_NORATING = '–';    // символ «нет рейтинга Кинопоиска»

  function colorsOn() { return field(KEY.colors, true); }

  // красит бейдж по его тексту: 7+ зелёный, ниже — серый
  function colorize(el) {
    try {
      if (el.classList) {
        if (!colorsOn()) {
          el.classList.remove('kpr-v-green', 'kpr-v-gray');
          return;
        }
        var v = parseFloat(((el.innerText || el.textContent || '') + '').replace(',', '.'));
        if (isNaN(v) || v <= 0) return;
        var cls = v >= 7 ? 'kpr-v-green' : 'kpr-v-gray';
        if (el.classList.contains(cls)) return;
        el.classList.remove('kpr-v-green', 'kpr-v-gray');
        el.classList.add(cls);
      }
    } catch (e) {}
  }

  function isBadge(el) {
    var cn = ' ' + (el.className || '') + ' ';
    return cn.indexOf(' card__vote') >= 0 || cn.indexOf(' full-start__rate') >= 0;
  }

  /* ================= допатча DOM ================= */

  function fmtRating(r) {
    var v = Math.round(r * 10) / 10;
    return v >= 10 ? '10' : v.toFixed(1); // как штатный шаблон: cap 10, одна десятая
  }

  // сопоставить карточку с фильмом реестра: .card__title + .card__age (год)
  function resolveCard(card) {
    try {
      var tEl = card.querySelector('.card__title');
      if (!tEl) return null;
      var title = norm(tEl.textContent);
      if (!title) return null;
      var list = regByTitle[title];
      if (!list || !list.length) return null;
      var aEl = card.querySelector('.card__age');
      var year = parseInt((aEl && aEl.textContent || '0').replace(/\D/g, ''), 10) || 0;
      if (year) {
        var same = [];
        for (var i = 0; i < list.length; i++) if (list[i].year == year) same.push(list[i]);
        if (same.length == 1) return same[0];
        if (same.length > 1) return null; // неоднозначно — не трогаем
      }
      return list.length == 1 ? list[0] : null;
    } catch (e) { return null; }
  }

  // допатчить уже отрисованную карточку: текст бейджа + цвет;
  // если бейджа нет (у фильма не было рейтинга TMDB) — создаём его сами,
  // ровно как нативный рендер: <div class="card__vote"> внутри .card__view.
  // Если фильм в Кинопоиске не найден — вместо рейтинга TMDB показываем символ «–».
  function patchCard(card) {
    try {
      var badge = card.querySelector('.card__view .card__vote') || card.querySelector('.card__vote');
      var en = resolveCard(card);
      if (en && en.r > 0) {
        var txt = fmtRating(en.r);
        if (!badge) {
          var view = card.querySelector('.card__view');
          if (!view) return false;
          badge = document.createElement('div');
          badge.classList.add('card__vote');
          badge.innerText = txt;
          view.appendChild(badge);
          colorize(badge);
          return true;
        }
        if ((badge.innerText || badge.textContent) != txt) {
          badge.innerText = txt;
          badge.classList.remove('kpr-v-green', 'kpr-v-gray');
        }
        colorize(badge);
        return true;
      }
      if (en && en.done && badge) {
        // поиск завершён, рейтинга Кинопоиска нет — символ вместо рейтинга TMDB
        if ((badge.innerText || badge.textContent) != KP_NORATING) {
          badge.innerText = KP_NORATING;
          badge.classList.remove('kpr-v-green', 'kpr-v-gray');
        }
        return false;
      }
      if (badge) colorize(badge);
      return false;
    } catch (e) { return false; }
  }

  // пройти по всем карточкам страницы и допатчить те, чей рейтинг уже известен
  function patchCards() {
    try {
      if (typeof document == 'undefined' || !document.body) return;
      var cards = document.querySelectorAll('.card');
      for (var i = 0; i < cards.length; i++) patchCard(cards[i]);
    } catch (e) {}
  }

  /* ================= MutationObserver ================= */

  function scanNode(node) {
    if (!node || node.nodeType !== 1) return;

    // новые карточки: патчим бейдж, если рейтинг известен; иначе ищем по названию
    var cls = ' ' + (node.className || '') + ' ';
    if (cls.indexOf(' card ') >= 0) {
      patchCard(node);
      var en = resolveCard(node);
      if (!en) {
        // карточка не из реестра (клиент отдал TMDB-кеш без request_secuses) —
        // ищем по названию и году прямо из DOM
        var tEl = node.querySelector('.card__title');
        if (tEl) {
          var title = (tEl.textContent || '').trim();
          if (title) {
            var aEl = node.querySelector('.card__age');
            var year = parseInt((aEl && aEl.textContent || '0').replace(/\D/g, ''), 10) || 0;
            var key = keyOfTitle(title, year);
            if (!regByKey[key]) {
              var c = cacheGet(key);
              var e2 = regEntry('dom:' + key, title, year);
              regByKey[key] = e2;
              if (c) {
                e2.r = c.r; e2.v = c.v || 0; e2.done = true;
                patchCard(node);
              } else {
                lookup({ id: 'dom:' + key, title: title, year: year }, key);
              }
            }
          }
        }
      }
    }

    if (isBadge(node)) colorize(node);
    var inner = [];
    try { inner = node.querySelectorAll('.card__vote, .full-start__rate'); } catch (e) {}
    for (var i = 0; i < inner.length; i++) colorize(inner[i]);
  }

  function injectCss() {
    if (typeof document == 'undefined' || !document.head) return;
    try {
      var st = document.createElement('style');
      st.textContent = '.kpr-v-green{color:' + KP_GREEN + ' !important}' +
        '.kpr-v-gray{color:' + KP_GRAY + ' !important}';
      document.head.appendChild(st);
    } catch (e) {}
  }

  function watchDom() {
    if (typeof MutationObserver != 'function' || typeof document == 'undefined' || !document.body) return;
    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var add = muts[i].addedNodes;
          for (var j = 0; j < add.length; j++) scanNode(add[j]);
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      scanNode(document.body); // уже отрисованные бейджи
    } catch (e) {}
  }

  /* ================= настройки ================= */

  function settings() {
    var S = Lampa() && Lampa().SettingsApi;
    if (!S || typeof S.addComponent != 'function' || typeof S.addParam != 'function') return;

    S.addComponent({
      component: 'kpr',
      icon: '<svg width="39" height="39" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="white" stroke-width="2"/><path d="M10 8.5v7l5.5-3.5L10 8.5z" fill="white"/></svg>',
      name: 'Кинопоиск',
      after: 'tmdb'
    });

    S.addParam({
      component: 'kpr',
      param: { name: KEY.source, type: 'select', values: [SRC.kp, SRC.kpu, SRC.kpd], 'default': SRC.kp },
      field: { name: 'Источник API' },
      onChange: function () { gqlBlocked = false; }
    });

    S.addParam({
      component: 'kpr',
      param: { name: KEY.key, type: 'input', 'default': '' },
      field: { name: 'API-ключ (не нужен для kinopoisk.ru)' },
      onChange: function () { paused = false; warned = true; gqlBlocked = false; }
    });

    S.addParam({
      component: 'kpr',
      param: { name: KEY.replace, type: 'trigger', 'default': true },
      field: { name: 'Заменять рейтинг TMDB' }
    });

    S.addParam({
      component: 'kpr',
      param: { name: KEY.in_full, type: 'trigger', 'default': false },
      field: { name: 'Также на странице фильма (если нет другого плагина рейтингов)' }
    });

    S.addParam({
      component: 'kpr',
      param: { name: KEY.colors, type: 'trigger', 'default': true },
      field: { name: 'Цвета Кинопоиска (7+ зелёный, ниже — серый)' }
    });

    S.addParam({
      component: 'kpr',
      param: { name: KEY.debug, type: 'trigger', 'default': false },
      field: { name: 'Отладка (лог в консоль)' }
    });

    S.addParam({
      component: 'kpr',
      param: { type: 'button' },
      field: { name: 'Очистить кеш рейтингов' },
      onChange: function () {
        try {
          var kill = [];
          for (var i = 0; i < global.localStorage.length; i++) {
            var k = global.localStorage.key(i);
            if (k && k.indexOf(CACHE_PREFIX) == 0) kill.push(k);
          }
          kill.forEach(function (k) { global.localStorage.removeItem(k); });
          try { Lampa().Noty.show('Кеш Кинопоиска очищен: ' + kill.length); } catch (e) {}
        } catch (e) {}
      }
    });
  }

  /* ================= манифест ================= */

  function manifest() {
    try {
      if (global.Lampa && global.Lampa.Manifest) {
        global.Lampa.Manifest.plugins = {
          type: 'rating',
          version: VERSION,
          name: 'Кинопоиск рейтинг',
          description: 'Заменяет рейтинг TMDB на карточках рейтингом Кинопоиска',
          author: 'Hermes'
        };
      }
    } catch (e) {}
  }

  /* ================= запуск ================= */

  function init() {
    if (!global.Lampa || !global.Lampa.Listener) return;
    manifest();
    try { settings(); } catch (e) {}
    global.Lampa.Listener.follow('request_secuses', onSecuses);
    try {
      if (typeof document != 'undefined') {
        injectCss();
        if (document.body) watchDom();
        else {
          var t2 = setInterval(function () {
            if (document.body) { clearInterval(t2); watchDom(); }
          }, 500);
          setTimeout(function () { clearInterval(t2); }, 30000);
        }
      }
    } catch (e) {}
    try { console.log('KP-Rating plugin', VERSION, 'loaded'); } catch (e) {}
  }

  if (global.Lampa && global.Lampa.Listener) init();
  else {
    var t = setInterval(function () {
      if (global.Lampa && global.Lampa.Listener) {
        clearInterval(t);
        init();
      }
    }, 300);
    setTimeout(function () { clearInterval(t); }, 30000);
  }
})(window);
