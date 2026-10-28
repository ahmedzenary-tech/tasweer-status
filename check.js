// Uptime check: runs from .github/workflows/uptime.yml every 5 minutes on the public status repository.
// Reads sites.json, checks the sites that are due, keeps 7 days of results in data/status.json,
// rewrites README.md (the status page), and opens or closes one issue per site that is down.
// Node 22, no dependencies. GITHUB_TOKEN and GITHUB_REPOSITORY come from the workflow.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'status.json');
const KEEP_MS = 7 * 24 * 3600e3;
const TIMEOUT_MS = 20e3;
// A site is up when it answers below 400, or with 401/403/405 (a sign-in page or a POST-only webhook is alive).
// 404 counts as down: n8n answers 404 when the webhook's workflow is not published.
const isUp = (code) => (code >= 200 && code < 400) || code === 401 || code === 403 || code === 405;

const { sites } = JSON.parse(fs.readFileSync(path.join(ROOT, 'sites.json'), 'utf8'));
const state = fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, 'utf8')) : { sites: {} };
const now = Date.now();

async function probe(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'tasweer-uptime' } });
    await r.arrayBuffer().catch(() => null);
    return { code: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { code: 0, ms: Date.now() - t0, error: e.name === 'TimeoutError' ? 'timeout' : String(e.cause?.code || e.message).slice(0, 80) };
  }
}

async function gh(method, url, body) {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return null;
  const r = await fetch(`https://api.github.com/repos/${repo}${url}`, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
  });
  if (!r.ok) { console.error(method, url, r.status, await r.text()); return null; }
  return r.status === 204 ? {} : r.json();
}

const pct = (xs) => xs.length ? (100 * xs.filter((x) => x.up).length / xs.length) : 100;
const fmtPct = (v) => (v === 100 ? '100' : v.toFixed(2)) + '%';
const cairo = (t) => new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short' });

(async () => {
  for (const s of sites) {
    const st = state.sites[s.id] ||= { history: [], up: true, since: now, issue: null };
    const last = st.history.at(-1);
    if (last && now - last.t < (s.every - 1) * 60e3) continue;
    let res = await probe(s.url);
    if (!isUp(res.code)) { await new Promise((r) => setTimeout(r, 5000)); res = await probe(s.url); } // one retry before calling it down
    const up = isUp(res.code);
    st.history.push({ t: now, code: res.code, ms: res.ms, up });
    st.history = st.history.filter((h) => now - h.t <= KEEP_MS);
    console.log(`${up ? 'UP  ' : 'DOWN'} ${s.id} ${res.code} ${res.ms}ms ${res.error || ''}`);

    if (up !== st.up) { st.up = up; st.since = now; }
    if (!up && !st.issue) {
      const issue = await gh('POST', '/issues', {
        title: `🔴 ${s.name} متوقف`,
        labels: ['outage'],
        body: `**${s.name}** لا يستجيب منذ ${cairo(now)} (توقيت الإمارات).\n\n- الرابط: ${s.url}\n- الرد: ${res.code || res.error}\n- الزمن: ${res.ms} ms\n\nسيُغلق هذا البلاغ تلقائياً عند عودة الخدمة.`,
      });
      if (issue) st.issue = issue.number;
    } else if (up && st.issue) {
      const mins = Math.round((now - (st.history.findLast((h) => !h.up)?.t ?? now)) / 60e3);
      await gh('POST', `/issues/${st.issue}/comments`, { body: `🟢 عادت الخدمة ${cairo(now)}. مدة التوقف تقريباً ${mins} دقيقة أو أقل.` });
      await gh('PATCH', `/issues/${st.issue}`, { state: 'closed', state_reason: 'completed' });
      st.issue = null;
    }
  }
  state.updated = now;
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(state));

  const rows = sites.map((s) => {
    const st = state.sites[s.id];
    const h = st?.history ?? [];
    const day = h.filter((x) => now - x.t <= 24 * 3600e3);
    const ok = h.filter((x) => x.up);
    const avg = ok.length ? Math.round(ok.reduce((a, x) => a + x.ms, 0) / ok.length) : 0;
    const icon = !st ? '⚪' : st.up ? '🟢' : '🔴';
    const bars = h.slice(-48).map((x) => (x.up ? '▮' : '▯')).join('');
    return `| ${icon} | ${s.name} | ${fmtPct(pct(day))} | ${fmtPct(pct(h))} | ${avg} ms | \`${bars}\` |`;
  });
  const anyDown = sites.some((s) => state.sites[s.id] && !state.sites[s.id].up);
  const readme = [
    '# حالة أنظمة الإعلام الأمني',
    '',
    anyDown ? '> 🔴 **يوجد عطل الآن.** راجع البلاغات المفتوحة في Issues.' : '> 🟢 **كل الأنظمة تعمل.**',
    '',
    '| | الخدمة | آخر 24 ساعة | آخر 7 أيام | متوسط الرد | آخر الفحوص |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    `آخر فحص: ${cairo(now)} (توقيت الإمارات). يُفحص كل 5 دقائق، ولوحة التحكم والنموذج كل 30 دقيقة.`,
    '',
    'عند توقف أي خدمة يُفتح بلاغ (Issue) تلقائياً ويصل تنبيه لمتابعي المستودع، ويُغلق البلاغ وحده عند العودة.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'README.md'), readme);
})().catch((e) => { console.error(e); process.exit(1); });
