// The desk's one script. Everything works without it; this makes the common
// actions one tap without a page load, and makes the slide strip feel native.
(() => {
  document.documentElement.classList.add('js');
  const toast = document.getElementById('toast');
  let toastTimer = null;
  const say = (msg, bad = false) => {
    if (!toast || !msg) return;
    toast.textContent = msg;
    toast.classList.toggle('bad', bad);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  };
  if (toast?.dataset.flash) say(toast.dataset.flash);

  // The desk's sidebar collapses to its icons and back; the choice is a cookie, so the next page arrives in shape.
  document.querySelector('[data-side]')?.addEventListener('click', (e) => {
    const mini = document.documentElement.classList.toggle('side-mini');
    const b = e.currentTarget;
    b.setAttribute('aria-expanded', String(!mini));
    b.setAttribute('aria-label', mini ? 'להרחיב את סרגל הצד' : 'לכווץ את סרגל הצד');
    b.title = mini ? 'להרחיב' : 'לכווץ';
    document.cookie = `of_side=${mini ? 'mini' : 'full'}; Path=/; Max-Age=31536000; SameSite=Strict`;
  });

  // The navigation bar lifts once the page scrolls under it.
  const lift = () => document.documentElement.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', lift, { passive: true });
  lift();

  // Two taps for anything that cannot be undone in one.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-confirm]');
    if (!b) return;
    if (b.dataset.armed === '1') return;
    e.preventDefault();
    b.dataset.armed = '1';
    b.dataset.label = b.innerHTML;
    b.classList.add('armed');
    b.textContent = b.dataset.confirm;
    setTimeout(() => {
      if (b.dataset.armed === '1') {
        b.dataset.armed = '';
        b.classList.remove('armed');
        b.innerHTML = b.dataset.label;
      }
    }, 3500);
  });

  // Show or hide a panel (the reject box).
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-toggle]');
    if (!b) return;
    const box = document.querySelector(b.dataset.toggle);
    if (!box) return;
    const open = box.classList.toggle('open');
    b.setAttribute('aria-expanded', String(open));
    if (open) box.querySelector('select, input, textarea')?.focus();
  });

  // Forms marked data-ajax post in the background.
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-ajax]');
    if (!form) return;
    const btn = form.querySelector('[data-confirm]');
    if (btn && btn.dataset.armed !== '1') return;
    e.preventDefault();
    const submit = form.querySelector('button[type=submit]');
    submit?.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'x-of-ajax': '1', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
        credentials: 'same-origin',
      });
      const out = await res.json().catch(() => ({ ok: false, message: 'תשובה לא צפויה מהשרת' }));
      // The session ended (signed out elsewhere, or expired): off to accounts' login, which brings the browser back.
      if (res.status === 401 && typeof out.login === 'string' && /^https?:\/\//.test(out.login)) {
        location.href = out.login;
        return;
      }
      const kind = form.dataset.ajax;
      if (kind === 'theme' && out.theme) {
        document.documentElement.dataset.theme = out.theme;
        return;
      }
      say(out.message, !out.ok);
      if (!out.ok) return;
      if (kind === 'remove') {
        const card = form.closest('[data-post]');
        if (card) {
          card.style.maxHeight = `${card.scrollHeight}px`;
          card.classList.add('leaving');
          setTimeout(() => card.classList.add('gone'), 220);
          setTimeout(() => card.remove(), 600);
        }
      } else if (kind === 'reload') {
        setTimeout(() => location.reload(), 400);
      }
    } catch {
      say('אין חיבור. נסו שוב.', true);
    } finally {
      submit?.removeAttribute('aria-busy');
    }
  });

  // Notifications in this browser: the service worker, the permission, the subscription, then the endpoint is kept.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-push-enable]');
    if (!btn) return;
    const form = btn.closest('form[data-push]');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return say('הדפדפן הזה לא תומך בהתראות. בטלפון: הוסיפו את תדר למסך הבית ונסו משם.', true);
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      if ((await Notification.requestPermission()) !== 'granted') return say('ההתראות לא אושרו בדפדפן.', true);
      const raw = atob(form.dataset.push.replace(/-/g, '+').replace(/_/g, '/'));
      const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      form.querySelector('[name=endpoint]').value = sub.endpoint;
      form.requestSubmit();
    } catch {
      say('לא הצלחתי להפעיל התראות בדפדפן הזה.', true);
    }
  });

  // This device's own state: a device already subscribed is offered the off button instead.
  const pushOn = document.querySelector('form[data-push]');
  const pushOff = document.querySelector('form[data-push-off]');
  const thisSub = async () => {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : null;
    return reg?.pushManager ? reg.pushManager.getSubscription() : null;
  };
  if (pushOn && pushOff) {
    thisSub()
      .then((sub) => {
        if (!sub) return;
        pushOn.hidden = true;
        pushOff.hidden = false;
      })
      .catch(() => {});
  }
  document.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-push-disable]') || !pushOff) return;
    try {
      const sub = await thisSub();
      if (!sub) return say('ההתראות כבר כבויות במכשיר הזה.');
      pushOff.querySelector('[name=endpoint]').value = sub.endpoint;
      await sub.unsubscribe();
      pushOff.requestSubmit();
    } catch {
      say('לא הצלחתי לכבות את ההתראות במכשיר הזה.', true);
    }
  });

  // A segmented control submits as soon as it changes.
  document.querySelectorAll('form[data-autosubmit]').forEach((form) => {
    form.addEventListener('change', () => form.requestSubmit());
  });

  // A list typed one item at a time (a new account's topics and sites, [data-pills]): Enter makes what was typed a pill,
  // the pills sit in a row, × takes one out, and Backspace in the empty box takes the last. The form sends the field it
  // had, the pills one a line (the server reads them so: onboarding.js listField), and something typed and not yet a
  // pill goes with it. Without this script the field stays as it was (topics by commas, sites a line each).
  document.querySelectorAll('[data-pills]').forEach((field) => {
    const max = Number(field.dataset.max) || 10;
    const required = field.required;
    const items = [...new Set(field.value.split(field.dataset.pills === 'commas' ? /\r?\n|[,،]/ : /\r?\n/).map((x) => x.trim()).filter(Boolean))].slice(0, max);
    const sent = Object.assign(document.createElement('input'), { type: 'hidden', name: field.name });
    const box = Object.assign(document.createElement('div'), { className: 'pills' });
    const list = Object.assign(document.createElement('ul'), { className: 'pill-list' });
    const typed = Object.assign(document.createElement('input'), { type: 'text', className: 'pill-typed' });
    typed.dir = field.dir || 'auto';
    typed.setAttribute('enterkeyhint', 'enter');
    if (field.dir === 'ltr') {
      typed.setAttribute('autocapitalize', 'off');
      typed.spellcheck = false;
    }
    field.removeAttribute('name');
    field.required = false;
    field.hidden = true;
    // The box's own field first, so a tap on the label goes to it and never to a pill's ×; CSS draws the pills before it.
    box.append(typed, list);
    field.before(box, sent);
    const draw = () => {
      list.replaceChildren(
        ...items.map((text, i) => {
          const li = Object.assign(document.createElement('li'), { className: 'pill' });
          const word = Object.assign(document.createElement('span'), { textContent: text, dir: 'auto' });
          const x = Object.assign(document.createElement('button'), { type: 'button', textContent: '×' });
          x.setAttribute('aria-label', `להסיר את ${text}`);
          x.addEventListener('click', () => {
            items.splice(i, 1);
            draw();
            typed.focus();
          });
          li.append(word, x);
          return li;
        })
      );
      sent.value = items.join('\n');
      typed.required = required && !items.length;
      typed.disabled = items.length >= max;
    };
    const add = (text) => {
      const v = text.trim();
      if (v && !items.includes(v) && items.length < max) items.push(v);
    };
    typed.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        add(typed.value);
        typed.value = '';
        draw();
      } else if (e.key === 'Backspace' && !typed.value && items.length) {
        items.pop();
        draw();
      }
    });
    // Lines pasted together become a pill each.
    typed.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') || '';
      if (!/\n/.test(text)) return;
      e.preventDefault();
      text.split(/\r?\n/).forEach(add);
      draw();
    });
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target === list) typed.focus();
    });
    // Before the form's data is gathered: what was typed without Enter is a pill too.
    field.form?.addEventListener('submit', () => {
      if (!typed.value.trim()) return;
      add(typed.value);
      typed.value = '';
      draw();
    });
    draw();
  });

  // Dots that follow the slide strip.
  document.querySelectorAll('[data-strip]').forEach((strip) => {
    const dots = strip.nextElementSibling?.matches('.dots') ? [...strip.nextElementSibling.children] : [];
    if (!dots.length || !('IntersectionObserver' in window)) return;
    const slides = [...strip.children];
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.intersectionRatio > 0.6) {
            const i = slides.indexOf(en.target);
            dots.forEach((d, k) => d.classList.toggle('on', k === i));
          }
        }
      },
      { root: strip, threshold: [0.6] }
    );
    slides.forEach((s) => io.observe(s));
  });

  // A link to a folded panel on the same page (Edit, to #edit) opens it.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    const target = a && a.getAttribute('href').length > 1 ? document.querySelector(a.getAttribute('href')) : null;
    if (target?.tagName === 'DETAILS') target.open = true;
  });

  // Tapping a slide opens its facts.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('.strip a[href^="#s-"]');
    if (!a) return;
    const target = document.querySelector(a.getAttribute('href'));
    const details = target?.closest('details');
    if (details) details.open = true;
    const first = target?.querySelector('details.fact');
    if (first) first.open = true;
  });
  // The account switcher closes when a tap or a key goes elsewhere, as a menu does.
  const closeSwitch = (e) => {
    const sw = document.querySelector('details.acctswitch[open]');
    if (sw && (e.type === 'keydown' ? e.key === 'Escape' : !sw.contains(e.target))) sw.open = false;
  };
  document.addEventListener('click', closeSwitch);
  document.addEventListener('keydown', closeSwitch);
  // A page waiting on work in the background (a new account's search for sources, its sample posts) asks how it goes
  // and changes only its progress line: never a reload under someone typing. When there is something new to show, the
  // page moves on by itself if nothing was typed, else it says so and waits for a tap. A block that lists several
  // pieces of work (home's, data-swap, src/web/progress.js) gets a line each by its name, and when there is something
  // new to show it is drawn again in place from the answer's html, never a reload; empty, it goes.
  const poll = document.querySelector('[data-poll]');
  if (poll) {
    let typed = false;
    document.addEventListener('input', (e) => {
      if (e.target.closest('form')) typed = true;
    });
    const busyTyping = () => typed || Boolean(document.activeElement?.matches('input, textarea, select'));
    const tick = async () => {
      try {
        const res = await fetch(poll.dataset.poll, { credentials: 'same-origin', headers: { accept: 'application/json' } });
        if (res.ok) {
          const s = await res.json();
          const line = poll.querySelector('[data-progress]');
          if (line && s.line && line.textContent !== s.line) line.textContent = s.line;
          for (const el of poll.querySelectorAll('[data-progress]')) {
            const text = s.lines?.[el.dataset.progress];
            if (text && el.textContent !== text) el.textContent = text;
          }
          if (s.key && s.key !== poll.dataset.key && 'swap' in poll.dataset) {
            poll.innerHTML = s.html || '';
            poll.hidden = !s.html;
            poll.dataset.key = s.key;
            if (!s.busy) return;
          } else if (s.key && s.key !== poll.dataset.key) {
            if (!busyTyping()) {
              const to = new URL(poll.dataset.href, location.href);
              if (to.pathname !== location.pathname) return location.assign(to.href);
              if (to.hash) history.replaceState(null, '', to.hash);
              return location.reload();
            }
            const box = poll.querySelector('[data-ready]');
            if (box) {
              box.querySelector('[data-ready-text]').textContent = s.ready || '';
              box.querySelector('[data-ready-go]').textContent = s.go || '';
              box.hidden = false;
            }
            if (!s.busy) return;
            poll.dataset.key = s.key;
          }
        }
      } catch {
        /* the next tick asks again */
      }
      setTimeout(tick, 4000);
    };
    setTimeout(tick, 4000);
  }

  // Developer mode opens from the settings' version line, tapped seven times in a row: not a button anyone finds.
  let taps = 0;
  let lastTap = 0;
  document.addEventListener('click', (e) => {
    const line = e.target.closest('[data-devtap]');
    if (!line) return;
    const t = Date.now();
    taps = t - lastTap < 800 ? taps + 1 : 1;
    lastTap = t;
    if (taps >= 7) line.submit();
  });

  // Loading (the same as Toran's): a tap never sits still. ~120ms after a link or a form is used (and not handled above), a bar runs along
  // the top; a link also turns the page under the header into the skeleton of the page that is coming, and a form's
  // button spins, until the next page paints. A quick page never shows any of it. Downloads, new tabs, other sites,
  // in-page anchors and the background forms (data-ajax) are left alone; Back to a page kept in memory gets it as it was.
  const root = document.documentElement;
  const main = document.getElementById('main');
  const base = root.dataset.base || '';
  const SHAPES = [
    [/^\/$/, 'today'],
    [/^\/(posts|all)$/, 'posts'],
    [/^\/post\/[^/]+$/, 'post'],
    [/^\/accounts$/, 'account'],
    [/^\/sources$/, 'cards'],
    [/^\/results$/, 'results'],
    [/^\/styles$/, 'styles'],
    [/^\/(settings|more)$/, 'cols'],
    [/^\/(facts|sounds|topics|rivals|demos)$/, 'list'],
  ];
  // A slide (/media/) opens as an image, not a page.
  const DOWNLOAD = /\.(csv|json|pdf|zip|png|jpe?g|webp|gif|svg)$|^\/media\//i;
  const shapeOf = (path) => {
    const p = base && path.startsWith(base) ? path.slice(base.length) || '/' : path;
    return (SHAPES.find(([re]) => re.test(p)) || [null, 'page'])[1];
  };
  const div = (cls, ...kids) => {
    const d = document.createElement('div');
    d.className = cls;
    d.append(...kids);
    return d;
  };
  const W = [78, 52, 88, 40, 66, 82, 46, 70];
  const line = (i, cls = '') => {
    const s = div(`sk ${cls}`);
    s.style.width = `${W[i % W.length]}%`;
    return s;
  };
  const lines = (n, from = 0) => div('sk-lines', ...Array.from({ length: n }, (_, i) => line(from + i)));
  const row = (i) => div('sk-row', div('sk dot'), div('sk-lines', line(i), line(i + 3, 'sub')), div('sk pill'));
  const rows = (n) => div('list', ...Array.from({ length: n }, (_, i) => row(i)));
  const panel = (n, from = 0) => div('panel', lines(n, from));
  const slides = (n) => div('sk-strip', ...Array.from({ length: n }, () => div('sk')));
  const post = (i) => div('card post panel', line(i, 'h1'), line(i + 2, 'sub'), slides(4), div('sk-acts', div('sk btn'), div('sk btn')));
  const BUILD = {
    today: () => [div('kpis', div('kpi lead', line(1), line(4, 'big')), div('kpi side', line(3), line(6, 'big'))), rows(4)],
    posts: () => [div('posts', post(0), post(3))],
    post: () => [div('cols', div('grid12', post(1)), div('grid12', panel(5, 2), panel(4, 5)))],
    cards: () => [div('accounts', ...[0, 1].map((i) => div('card panel', lines(5, i), div('sk-acts', div('sk btn')))))],
    // The account page's own shape: its header, then the grid of panels (style.css .acct-grid).
    account: () => [div('acct', div('panel acct-head', lines(2)), div('acct-grid', ...[0, 1, 2].map((i) => panel(4, i))))],
    results: () => [div('kpis', div('kpi lead', line(1), line(4, 'big')), div('kpi side', line(3), line(6, 'big'))), panel(4, 1), rows(5)],
    styles: () => [div('panel', line(2), div('sk-styles', ...Array.from({ length: 5 }, () => div('sk'))))],
    list: () => [rows(7)],
    cols: () => [div('cols', div('grid12', panel(6), panel(4, 2)), div('grid12', panel(5, 1)))],
    page: () => [panel(5), panel(3, 3)],
  };
  const skeleton = (shape) => {
    const page = div('sk-page', div('sk-head', line(0, 'h1'), line(5, 'sub')), ...BUILD[shape]());
    page.setAttribute('role', 'status');
    page.prepend(Object.assign(document.createElement('span'), { className: 'sk-say', textContent: 'טוען…' }));
    return page;
  };

  let bar = null;
  let timer = 0;
  let busy = null;
  let navWas = null;
  let scrolled = null;
  const stop = () => {
    clearTimeout(timer);
    root.classList.remove('is-loading', 'sk-on');
    main?.querySelector(':scope > .sk-page')?.remove();
    main?.removeAttribute('aria-busy');
    busy?.removeAttribute('aria-busy');
    busy = null;
    if (navWas) for (const [a, cur] of navWas) cur ? a.setAttribute('aria-current', cur) : a.removeAttribute('aria-current');
    navWas = null;
    if (scrolled != null) window.scrollTo(0, scrolled);
    scrolled = null;
  };
  const start = (shape, button) => {
    stop();
    if (button) setTimeout(() => button.setAttribute('aria-busy', 'true')); // after the submit, so its name still goes
    busy = button;
    timer = setTimeout(() => {
      bar ??= document.body.appendChild(div('loadbar'));
      root.classList.add('is-loading');
      if (!shape || !main) return;
      main.prepend(skeleton(shape));
      main.setAttribute('aria-busy', 'true');
      root.classList.add('sk-on');
      scrolled = window.scrollY;
      window.scrollTo(0, 0);
    }, 120);
  };
  const leaves = (url) => url.origin === location.origin && !DOWNLOAD.test(url.pathname) && !(url.pathname === location.pathname && url.search === location.search && url.hash);

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((a.target && a.target !== '_self') || a.hasAttribute('download') || a.hasAttribute('data-no-wait')) return;
    const url = new URL(a.href, location.href);
    if (!leaves(url)) return;
    // The tab you tapped lights up now, not when its page arrives.
    const nav = a.closest('nav.nav, nav.tabbar');
    if (nav) {
      navWas = [...document.querySelectorAll('nav.nav a, nav.tabbar a')].map((x) => [x, x.getAttribute('aria-current')]);
      const keep = navWas;
      start(shapeOf(url.pathname));
      navWas = keep;
      for (const [x] of navWas) x.toggleAttribute('aria-current', x.getAttribute('href') === a.getAttribute('href'));
      for (const [x] of navWas) if (x.hasAttribute('aria-current')) x.setAttribute('aria-current', 'page');
    } else start(shapeOf(url.pathname));
  });
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (e.defaultPrevented || (form.target && form.target !== '_self') || form.hasAttribute('data-no-wait')) return;
    const url = new URL(form.getAttribute('action') || location.href, location.href);
    if (url.origin !== location.origin || DOWNLOAD.test(url.pathname)) return;
    if ((form.getAttribute('method') || 'get').toLowerCase() === 'get') start(shapeOf(url.pathname));
    else start(null, e.submitter || form.querySelector('[type=submit], button:not([type])'));
  });
  window.addEventListener('pageshow', (e) => e.persisted && stop());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && root.classList.contains('is-loading') && stop());

  // Slides on their way keep their box, shimmering (style.css), until they are in.
  const mark = (img) => img.classList.add('ok');
  for (const img of document.querySelectorAll('main img')) {
    if (img.complete) mark(img);
    else for (const ev of ['load', 'error']) img.addEventListener(ev, () => mark(img), { once: true });
  }
})();
