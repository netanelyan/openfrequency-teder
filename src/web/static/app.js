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
  // page moves on by itself if nothing was typed, else it says so and waits for a tap.
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
          if (s.key && s.key !== poll.dataset.key) {
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
})();
