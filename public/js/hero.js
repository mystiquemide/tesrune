// Hero live clock. Drives the window pill and the countdown to the next bell
// from the real /api/state clock. No mock values.

const WINDOWS = {
  dark: { label: 'DARK', cls: 'pill-dark', broker: 'Closed' },
  pre_bell: { label: 'PRE-BELL', cls: 'pill-prebell', broker: 'Closed' },
  broker_open: { label: 'BROKER OPEN', cls: 'pill-open', broker: 'Open' }
};

function pad(n) { return String(n).padStart(2, '0'); }

function formatRemaining(ms) {
  if (ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (days > 0) return `${days}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function etHourMinute(et) {
  // et is "YYYY-MM-DD HH:MM:SS ET"
  const m = /\d{4}-\d{2}-\d{2} (\d{2}:\d{2})/.exec(et || '');
  return m ? m[1] : '';
}

async function init() {
  const pill = document.getElementById('window-pill');
  const label = document.getElementById('window-label');
  const countdown = document.getElementById('countdown');
  const broker = document.getElementById('broker-status');
  if (!pill || !countdown) return;

  let state;
  try {
    const res = await fetch('/api/state', { headers: { Accept: 'application/json' } });
    state = await res.json();
  } catch {
    return; // page still renders; static labels remain
  }

  const clock = state.clock || {};
  const conf = WINDOWS[clock.window] || WINDOWS.dark;
  pill.className = `pill ${conf.cls}`;
  const hm = etHourMinute(clock.et);
  label.textContent = clock.window === 'dark' && hm ? `DARK ${hm} ET` : conf.label;
  if (broker) broker.textContent = conf.broker;

  const target = new Date(clock.nextBell).getTime();
  // Anchor to server clock, then advance locally so the tick stays smooth.
  const serverNow = new Date(clock.now).getTime();
  const drift = serverNow - Date.now();

  function tick() {
    countdown.textContent = formatRemaining(target - (Date.now() + drift));
  }
  tick();
  setInterval(tick, 1000);
}

function initMobileNav() {
  const toggle = document.getElementById('nav-toggle');
  const menu = document.getElementById('mobile-menu');
  if (!toggle || !menu) return;
  const setOpen = (open) => {
    menu.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  toggle.addEventListener('click', () => setOpen(!menu.classList.contains('open')));
  menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
}

initMobileNav();
init();
