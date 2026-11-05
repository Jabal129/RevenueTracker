'use strict';
/* تحصيل العقود — تطبيق هاتف (Capacitor). البيانات محلية في IndexedDB، والإشعارات محلية مجدولة بلا خادم. */

// ───────────── أدوات ─────────────
const CUR = 'ج.م';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').trim().replace(/[٠-٩]/g, d => d.charCodeAt(0) - 1632).replace(/٫/g, '.').replace(/[٬,،]/g, '');
const num = s => { const x = parseFloat(norm(s)); return Number.isFinite(x) ? x : NaN; };
const money = x => Number(x || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = () => window.__TODAY__ || iso(new Date());
const ms = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const daysBetween = (a, b) => Math.round((ms(b) - ms(a)) / 864e5);
const addDays = (s, n) => new Date(ms(s) + n * 864e5).toISOString().slice(0, 10);
const addMonths = (s, n) => {
  const [y, m, d] = s.split('-').map(Number), t = m - 1 + n, Y = y + Math.floor(t / 12), M = ((t % 12) + 12) % 12;
  return `${Y}-${pad(M + 1)}-${pad(Math.min(d, new Date(Date.UTC(Y, M + 1, 0)).getUTCDate()))}`;
};
// الكمية: عدد تواريخ الاستحقاق الشهرية الواقعة بين البداية والنهاية
const countMonths = (s, e) => { if (!s || !e || e < s) return 0; let n = 0; while (addMonths(s, n) <= e && n < 1200) n++; return n; };

// ───────────── قاعدة البيانات (IndexedDB) ─────────────
const DEF = { grace: 0, hour: 9, notify: 1 };
const DB = (() => {
  let db;
  const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const done = t => new Promise((ok, no) => { t.oncomplete = () => ok(); t.onerror = t.onabort = () => no(t.error); });
  const T = (n, m = 'readonly') => db.transaction(n, m);
  return {
    open: () => new Promise((ok, no) => {
      const r = indexedDB.open('tahseel', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('contracts', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('inst', { keyPath: 'id', autoIncrement: true }).createIndex('cid', 'cid');
        d.createObjectStore('payments', { keyPath: 'id', autoIncrement: true }).createIndex('cid', 'cid');
        d.createObjectStore('settings', { keyPath: 'k' });
      };
      r.onsuccess = () => { db = r.result; ok(); };
      r.onerror = () => no(r.error);
    }),
    async all() {
      const t = T(['contracts', 'inst', 'payments']), g = n => req(t.objectStore(n).getAll());
      const [c, i, p] = await Promise.all([g('contracts'), g('inst'), g('payments')]);
      return { c, i, p };
    },
    async settings() {
      const rows = await req(T(['settings']).objectStore('settings').getAll()), o = { ...DEF };
      rows.forEach(r => { o[r.k] = r.v; });
      return o;
    },
    setSetting(k, v) {
      const t = T(['settings'], 'readwrite'), fin = done(t);
      t.objectStore('settings').put({ k, v });
      return fin;
    },
    addContract(c) {
      const t = T(['contracts', 'inst'], 'readwrite'), fin = done(t), n = countMonths(c.start, c.end);
      let id;
      t.objectStore('contracts').add({ ...c, months: n }).onsuccess = e => {
        id = e.target.result;
        const I = t.objectStore('inst');
        for (let k = 0; k < n; k++) I.add({ cid: id, n: k + 1, due: addMonths(c.start, k), amount: c.monthly, pid: null });
      };
      return fin.then(() => id);
    },
    deleteContract(id) {
      const t = T(['contracts', 'inst', 'payments'], 'readwrite'), fin = done(t);
      t.objectStore('contracts').delete(id);
      ['inst', 'payments'].forEach(s => {
        const st = t.objectStore(s);
        st.index('cid').getAllKeys(id).onsuccess = e => e.target.result.forEach(k => st.delete(k));
      });
      return fin;
    },
    setImage(cid, url) {
      const t = T(['contracts'], 'readwrite'), fin = done(t), s = t.objectStore('contracts');
      s.get(cid).onsuccess = e => { const c = e.target.result; if (c) { c.image = url; s.put(c); } };
      return fin;
    },
    // تحصيل واحد قد يغطي عدة أشهر (مجمّع / مقدّم) بإثبات واحد
    addPayment(cid, ids, paid, proof, note) {
      const t = T(['inst', 'payments'], 'readwrite'), fin = done(t), I = t.objectStore('inst'), P = t.objectStore('payments');
      const rows = []; let left = ids.length;
      ids.forEach(id => { I.get(id).onsuccess = e => {
        const r = e.target.result;
        if (r && r.cid === cid && !r.pid) rows.push(r);
        if (--left || !rows.length) return;
        const amount = rows.reduce((s, x) => s + x.amount, 0);
        P.add({ cid, paid, amount, proof: proof || null, note: note || '' }).onsuccess = ev => {
          rows.forEach(x => { x.pid = ev.target.result; I.put(x); });
        };
      }; });
      return fin;
    },
    deletePayment(pid) {
      const t = T(['inst', 'payments'], 'readwrite'), fin = done(t), P = t.objectStore('payments'), I = t.objectStore('inst');
      P.get(pid).onsuccess = e => {
        const p = e.target.result; if (!p) return;
        I.index('cid').getAll(p.cid).onsuccess = ev => {
          ev.target.result.filter(i => i.pid === pid).forEach(i => { i.pid = null; I.put(i); });
          P.delete(pid);
        };
      };
      return fin;
    },
    setProof(pid, url) {
      const t = T(['payments'], 'readwrite'), fin = done(t), P = t.objectStore('payments');
      P.get(pid).onsuccess = e => { const p = e.target.result; if (p) { p.proof = url; P.put(p); } };
      return fin;
    },
    importAll(o) {
      const names = ['contracts', 'inst', 'payments', 'settings'], t = T(names, 'readwrite'), fin = done(t);
      const data = { contracts: o.c, inst: o.i, payments: o.p, settings: Object.entries(o.st || {}).map(([k, v]) => ({ k, v })) };
      names.forEach(n => { const s = t.objectStore(n); s.clear(); (data[n] || []).forEach(r => s.put(r)); });
      return fin;
    },
  };
})();

// ───────────── النموذج: المتأخرات وحالة الأشهر ─────────────
function model(d, st) {
  const today = TODAY(), grace = +st.grace || 0, late = [];
  const byC = {}, pays = {}, sizes = {};
  d.i.forEach(i => (byC[i.cid] ||= []).push(i));
  d.p.forEach(p => { pays[p.id] = p; });
  d.i.forEach(i => { if (i.pid) sizes[i.pid] = (sizes[i.pid] || 0) + 1; });
  const rows = d.c.map(c => {
    const its = (byC[c.id] || []).sort((a, b) => a.n - b.n);
    let paid = 0, np = 0, lateN = 0, lateAmt = 0;
    its.forEach(i => {
      i.days = daysBetween(i.due, today);
      if (i.pid) { paid += i.amount; np++; }
      else if (i.days > grace) { lateN++; lateAmt += i.amount; late.push({ ...i, title: c.title, client: c.client }); }
    });
    const total = its.reduce((s, i) => s + i.amount, 0);
    const status = its.length && np === its.length ? 'مكتمل' : lateN ? 'متأخر' : c.start > today ? 'لم يبدأ' : 'جارٍ';
    return { ...c, its, paid, np, total, rem: total - paid, lateN, lateAmt, status };
  }).sort((a, b) => b.id - a.id);
  return { rows, late, pays, sizes, byId: Object.fromEntries(rows.map(r => [r.id, r])) };
}

function monthStatus(i, m, grace) {
  const p = i.pid && m.pays[i.pid];
  if (p) return [p.paid.slice(0, 7) < i.due.slice(0, 7) ? 'محصّل مقدّمًا' : 'محصّل', 'ok'];
  if (i.days > grace) return [`متأخر ${i.days} يوم`, 'bad'];
  return i.days >= 0 ? ['مستحق', 'mid'] : ['قادم', ''];
}

// ───────────── خطة الإشعارات (دالة نقية قابلة للاختبار) ─────────────
function buildPlan(m, st, now = new Date()) {
  const plan = [], grace = +st.grace || 0, hh = Math.min(23, Math.max(0, +st.hour || 0)), today = TODAY();
  if (m.late.length) {
    const total = m.late.reduce((s, x) => s + x.amount, 0), nc = new Set(m.late.map(x => x.cid)).size;
    const lines = m.late.slice(0, 8).map(x => `• ${x.title} — شهر ${x.n} — متأخر ${x.days} يوم`);
    if (m.late.length > 8) lines.push(`… و${m.late.length - 8} أخرى`);
    plan.push({ id: 1, title: `⚠ ${m.late.length} تحصيل متأخر`, body: `في ${nc} عقد — الإجمالي ${money(total)} ${CUR}`, largeBody: lines.join('\n'), on: { hour: hh, minute: 0 } });
  }
  // تنبيه في اليوم الذي يصبح فيه كل شهر غير محصّل متأخرًا
  const byDate = {};
  m.rows.forEach(r => r.its.forEach(i => { if (!i.pid) { const ld = addDays(i.due, grace + 1); if (ld > today) (byDate[ld] ||= []).push({ r, i }); } }));
  Object.keys(byDate).sort().slice(0, 40).forEach((ld, k) => {
    const [y, mo, d] = ld.split('-').map(Number), at = new Date(y, mo - 1, d, hh, 0, 0), xs = byDate[ld];
    if (at <= now) return;
    const names = [...new Set(xs.map(x => x.r.title))];
    plan.push({
      id: 100 + k, at,
      title: xs.length === 1 ? 'تأخر تحصيل شهر' : `تأخر تحصيل ${xs.length} أشهر`,
      body: xs.length === 1 ? `${names[0]} — الشهر ${xs[0].i.n} (استحقاق ${xs[0].i.due})` : `${names.slice(0, 3).join('، ')}${names.length > 3 ? ' وغيرها' : ''}`,
    });
  });
  return plan;
}

// ───────────── الإشعارات المحلية (Capacitor) ─────────────
const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const plug = n => (window.Capacitor.Plugins && window.Capacitor.Plugins[n]) || window.Capacitor.registerPlugin(n);
const CH = { id: 'overdue', name: 'تأخر التحصيل', description: 'تنبيهات الأشهر المتأخرة التحصيل', importance: 4, visibility: 1, vibration: true };

async function notifPerm() { return isNative() ? (await plug('LocalNotifications').checkPermissions()).display : 'web'; }
async function enableNotifs() {
  if (!isNative()) return 'web';
  const p = (await plug('LocalNotifications').requestPermissions()).display;
  await reschedule();
  return p;
}
async function doReschedule() {
  if (!isNative()) return 0;
  try {
    const LN = plug('LocalNotifications'), st = await DB.settings();
    const pend = await LN.getPending();
    if (pend.notifications.length) await LN.cancel({ notifications: pend.notifications.map(n => ({ id: n.id })) });
    if (!+st.notify || (await LN.checkPermissions()).display !== 'granted') return 0;
    await LN.createChannel(CH);
    const plan = buildPlan(model(await DB.all(), st), st);
    if (plan.length) await LN.schedule({ notifications: plan.map(p => ({
      id: p.id, title: p.title, body: p.body, largeBody: p.largeBody, summaryText: p.largeBody ? 'تحصيل العقود' : undefined,
      channelId: CH.id, schedule: p.at ? { at: p.at, allowWhileIdle: true } : { on: p.on, allowWhileIdle: true },
    })) });
    return plan.length;
  } catch (e) { console.error('notif', e); return -1; }
}
let chain = Promise.resolve();
const reschedule = () => (chain = chain.then(doReschedule, doReschedule));

// ───────────── صور الإثبات ─────────────
const readUrl = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
async function shrink(file, max = 1400) {
  const url = await readUrl(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
    const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.75);
  } catch { return url; }
}
const pickImage = cam => new Promise(ok => {
  const el = $(cam ? '#pickCam' : '#pickFile');
  el.value = '';
  el.onchange = async () => ok(el.files[0] ? await shrink(el.files[0]) : null);
  el.click();
});

// ───────────── واجهة ─────────────
let M, ST, PRE = null;
const draft = {};
const cls = s => ({ 'مكتمل': 'ok', 'متأخر': 'bad', 'جارٍ': 'mid' }[s] || '');
let tt;
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2400); };
const viewImg = url => { $('#viewer img').src = url; $('#viewer').hidden = false; };
function sheet(title, items) {
  const s = $('#sheet');
  s.innerHTML = `<div class="back"></div><div class="box"><h3>${esc(title)}</h3>${items.map((x, k) => `<button class="btn ${x[2] || 'alt'}" data-k="${k}">${esc(x[0])}</button>`).join('')}<button class="btn alt" data-k="x">إلغاء</button></div>`;
  s.hidden = false;
  s.onclick = e => {
    if (e.target.classList.contains('back')) s.hidden = true;
    const b = e.target.closest('[data-k]'); if (!b) return;
    s.hidden = true;
    if (b.dataset.k !== 'x') items[b.dataset.k][1]();
  };
}
const imgField = (key, label) => `<div class="field"><label>${label}</label><div class="btns"><button type="button" class="btn alt" data-act="pick" data-key="${key}" data-cam="1">📷 التقاط</button><button type="button" class="btn alt" data-act="pick" data-key="${key}">🖼 من المعرض</button></div><div id="prev-${key}" class="prev"></div></div>`;

function homeScreen(m) {
  const paid = m.rows.reduce((s, r) => s + r.paid, 0), rem = m.rows.reduce((s, r) => s + r.rem, 0), lateAmt = m.late.reduce((s, x) => s + x.amount, 0);
  const card = r => `<a class="card ${r.lateN ? 'late' : ''}" href="#/c/${r.id}"><div class="row"><b>${esc(r.title)}</b><span class="chip ${cls(r.status)}">${r.status}${r.lateN ? ` (${r.lateN})` : ''}</span></div>${r.client ? `<div class="sub">${esc(r.client)}</div>` : ''}<div class="bar"><i style="width:${r.its.length ? Math.round(r.np / r.its.length * 100) : 0}%"></i></div><div class="row sub"><span>${r.np} / ${r.its.length} شهر</span><span>المتبقي ${money(r.rem)} ${CUR}</span></div></a>`;
  return {
    t: 'تحصيل العقود', root: true,
    h: `<div class="sum"><div><small>المحصّل</small><b>${money(paid)}</b></div><div><small>المتبقي</small><b>${money(rem)}</b></div><div class="${m.late.length ? 'bad' : ''}"><small>المتأخر</small><b>${money(lateAmt)}</b></div></div>
      ${m.late.length ? `<a class="alert" href="#/late">⚠ ${m.late.length} شهر متأخر التحصيل في ${new Set(m.late.map(x => x.cid)).size} عقد — اضغط للتفاصيل</a>` : ''}
      <div id="nb"></div>
      ${m.rows.map(card).join('') || '<p class="empty">لا توجد عقود بعد.<br>اضغط ＋ لإضافة أول عقد.</p>'}
      <a class="fab" href="#/add" aria-label="إضافة عقد">＋</a>`,
    after: async () => {
      if (isNative() && +ST.notify && (await notifPerm()) !== 'granted')
        $('#nb').innerHTML = '<div class="alert warn">الإشعارات غير مفعّلة، فلن تصلك تنبيهات التأخر. <button class="btn" data-act="enableN" style="margin-top:8px">تفعيل الإشعارات</button></div>';
    },
  };
}

function addScreen() {
  draft.c = null;
  const t = TODAY();
  return {
    t: 'إضافة عقد',
    h: `<div class="field"><label>اسم / رقم العقد *</label><input id="f-title" type="text"></div>
      <div class="field"><label>الجهة / العميل</label><input id="f-client" type="text"></div>
      <div class="field"><label>تاريخ البداية *</label><input id="f-start" type="date" value="${t}"></div>
      <div class="field"><label>تاريخ النهاية *</label><input id="f-end" type="date" value="${addDays(addMonths(t, 12), -1)}"></div>
      <div class="field"><label>قيمة التحصيل الشهرية * (${CUR})</label><input id="f-amt" type="text" inputmode="decimal"></div>
      <div id="f-info" class="info"></div>
      ${imgField('c', 'صورة العقد')}
      <div class="field"><label>ملاحظات</label><input id="f-notes" type="text"></div>
      <button class="btn" data-act="addSave">حفظ العقد</button>`,
    after: calcAdd,
  };
}
function calcAdd() {
  const n = countMonths($('#f-start').value, $('#f-end').value), a = num($('#f-amt').value);
  $('#f-info').textContent = n ? `الكمية: ${n} شهرًا${a > 0 ? ` — إجمالي قيمة العقد: ${money(n * a)} ${CUR}` : ''}` : '';
}

function contractScreen(m, st, id) {
  const r = m.byId[id];
  if (!r) return { t: 'غير موجود', h: '<p class="empty">العقد غير موجود.</p>' };
  const grace = +st.grace || 0;
  const rows = r.its.map(i => {
    const [chip, c] = monthStatus(i, m, grace), p = i.pid && m.pays[i.pid];
    const sub = p ? ` • سُجّل ${p.paid} • ${p.proof ? '📎 إثبات' : '⚠ بلا إثبات'}${m.sizes[i.pid] > 1 ? ` • تحصيل مجمّع (${m.sizes[i.pid]} أشهر)` : ''}` : '';
    return `<div class="mrow ${c}" data-act="row" data-id="${i.id}"><div><b>الشهر ${i.n}</b> <span class="sub">${i.due}</span></div><div class="sub">${money(i.amount)} ${CUR}${sub}</div><span class="chip ${c}">${chip}</span></div>`;
  }).join('');
  return {
    t: r.title,
    h: `<div class="panel"><h2>${esc(r.title)}</h2>${r.client ? `<div class="sub">${esc(r.client)}</div>` : ''}
      <div class="sub">من ${r.start} إلى ${r.end} (${r.months} شهرًا) • القيمة الشهرية ${money(r.monthly)} ${CUR}</div>
      <div class="sub">المحصّل ${money(r.paid)} • المتبقي ${money(r.rem)} • المتأخر ${money(r.lateAmt)} (${r.lateN} شهر)</div>
      ${r.notes ? `<div class="sub">ملاحظات: ${esc(r.notes)}</div>` : ''}</div>
      <div class="btns"><a class="btn" href="#/pay/${r.id}">＋ تسجيل تحصيل</a><button class="btn alt" data-act="cimg" data-id="${r.id}">🖼 صورة العقد</button><button class="btn danger" data-act="delc" data-id="${r.id}">🗑 حذف</button></div>
      ${rows}`,
  };
}

function payScreen(m, st, id) {
  const r = m.byId[id], grace = +st.grace || 0;
  if (!r) return { t: 'غير موجود', h: '<p class="empty">العقد غير موجود.</p>' };
  const un = r.its.filter(i => !i.pid);
  if (!un.length) return { t: 'تسجيل تحصيل', h: '<p class="empty">كل أشهر هذا العقد محصّلة ✔</p>' };
  draft.p = null;
  const pre = PRE && un.some(i => i.id === PRE) ? PRE : un[0].id; PRE = null;
  const list = un.map(i => { const [chip, c] = monthStatus(i, m, grace); return `<label class="mrow pick ${c}"><input type="checkbox" class="mchk" value="${i.id}" data-amt="${i.amount}" ${i.id === pre ? 'checked' : ''}><span><b>الشهر ${i.n}</b> <span class="sub">${i.due} • ${money(i.amount)}</span></span><span class="chip ${c}">${chip}</span></label>`; }).join('');
  return {
    t: 'تسجيل تحصيل — ' + r.title,
    h: `<p class="sub">اختر الأشهر التي يغطيها هذا التحصيل (عدة أشهر = تحصيل مجمّع / مقدّم بإثبات واحد):</p>
      <div class="row" style="gap:6px"><span>تحديد أول</span><input id="qn" type="number" min="1" max="${un.length}" value="1" style="width:70px"><span>شهر</span><button class="btn alt" style="flex:0" data-act="qsel">تحديد</button></div>
      <div style="margin-top:10px">${list}</div><div id="tot" class="tot"></div>
      <div class="field"><label>تاريخ تسجيل التحصيل</label><input id="p-date" type="date" value="${TODAY()}"></div>
      ${imgField('p', 'صورة الإيصال / إثبات')}
      <div class="field"><label>ملاحظة</label><input id="p-note" type="text"></div>
      <button class="btn" data-act="paySave" data-id="${r.id}">حفظ التحصيل</button>`,
    after: calcTot,
  };
}
function calcTot() {
  const ch = [...document.querySelectorAll('.mchk:checked')];
  $('#tot').textContent = `الأشهر المحددة: ${ch.length} — إجمالي التحصيل: ${money(ch.reduce((s, x) => s + +x.dataset.amt, 0))} ${CUR}`;
}

function lateScreen(m) {
  const by = {};
  m.late.forEach(x => (by[x.cid] ||= []).push(x));
  const total = m.late.reduce((s, x) => s + x.amount, 0);
  const body = Object.values(by).map(xs => `<div class="panel"><a href="#/c/${xs[0].cid}"><h2>${esc(xs[0].title)}</h2></a>${xs.map(x => `<a href="#/c/${x.cid}" class="row sub" style="padding:4px 0"><span>الشهر ${x.n} • ${x.due}</span><span>${money(x.amount)} ${CUR} • <b style="color:var(--bad)">${x.days} يوم</b></span></a>`).join('')}</div>`).join('');
  return { t: 'المتأخرات', h: m.late.length ? `<div class="alert">${m.late.length} شهر متأخر — الإجمالي ${money(total)} ${CUR}</div>${body}` : '<p class="empty">لا توجد تحصيلات متأخرة 👍</p>' };
}

function settingsScreen(m, st) {
  return {
    t: 'الإعدادات',
    h: `<div class="field"><label>مهلة السماح قبل اعتبار الشهر متأخرًا (أيام)</label><input id="s-grace" type="number" min="0" value="${+st.grace || 0}"></div>
      <div class="field"><label>ساعة الإشعار اليومي (0–23)</label><input id="s-hour" type="number" min="0" max="23" value="${+st.hour}"></div>
      <label class="chk"><input id="s-notify" type="checkbox" ${+st.notify ? 'checked' : ''}> تفعيل إشعارات التأخر</label>
      <button class="btn" data-act="saveSet">حفظ الإعدادات</button>
      <h3>الإشعارات</h3><p id="nstat" class="sub"></p>
      <div class="btns"><button class="btn alt" data-act="enableN">تفعيل إذن الإشعارات</button><button class="btn alt" data-act="testN">إشعار تجريبي</button></div>
      <p class="sub">بعض الهواتف (شاومي، هواوي، أوبو…) توقف التطبيقات لتوفير البطارية. استثنِ هذا التطبيق من «توفير البطارية» ليصل التنبيه في موعده.</p>
      <h3>النسخ الاحتياطي</h3>
      <p class="sub">البيانات محفوظة على هذا الهاتف فقط. صدّر نسخة بانتظام، فحذف التطبيق يحذف بياناته.</p>
      <div class="btns"><button class="btn alt" data-act="exp">تصدير نسخة</button><button class="btn alt" data-act="imp">استيراد نسخة</button></div>`,
    after: async () => {
      if (!isNative()) { $('#nstat').textContent = 'الإشعارات تعمل داخل تطبيق الهاتف فقط (ليس في المتصفح).'; return; }
      const p = await notifPerm(), n = (await plug('LocalNotifications').getPending()).notifications.length;
      $('#nstat').textContent = `إذن الإشعارات: ${p === 'granted' ? 'مفعّل ✔' : 'غير مفعّل ✗'} — إشعارات مجدولة: ${n}`;
    },
  };
}

// ───────────── الإجراءات ─────────────
const A = {
  pick(d) { pickImage(d.cam).then(url => { if (url) { draft[d.key] = url; $('#prev-' + d.key).innerHTML = `<img src="${url}" alt="">`; } }); },
  async addSave() {
    const title = $('#f-title').value.trim(), start = $('#f-start').value, end = $('#f-end').value, amt = num($('#f-amt').value);
    if (!title) return toast('اكتب اسم أو رقم العقد');
    if (countMonths(start, end) < 1) return toast('تحقق من تاريخي البداية والنهاية');
    if (!(amt > 0)) return toast('القيمة الشهرية يجب أن تكون رقمًا أكبر من صفر');
    if (!draft.c && !confirm('لم تضف صورة العقد. المتابعة بدونها؟ (يمكن إرفاقها لاحقًا)')) return;
    const id = await DB.addContract({ title, client: $('#f-client').value.trim(), start, end, monthly: amt, image: draft.c || null, notes: $('#f-notes').value.trim() });
    toast('تم حفظ العقد');
    if (isNative()) enableNotifs(); else reschedule();
    location.replace('#/c/' + id);
  },
  qsel() {
    const n = Math.max(1, +$('#qn').value || 1);
    document.querySelectorAll('.mchk').forEach((c, k) => { c.checked = k < n; });
    calcTot();
  },
  async paySave(d) {
    const ids = [...document.querySelectorAll('.mchk:checked')].map(x => +x.value), date = $('#p-date').value;
    if (!ids.length) return toast('اختر شهرًا واحدًا على الأقل');
    if (!date) return toast('اكتب تاريخ التحصيل');
    if (!draft.p && !confirm('لم تضف صورة إيصال أو إثباتًا. حفظ التحصيل بدونه؟ (يمكن إرفاقه لاحقًا)')) return;
    await DB.addPayment(+d.id, ids, date, draft.p, $('#p-note').value.trim());
    toast('تم تسجيل التحصيل');
    reschedule();
    location.replace('#/c/' + d.id);
  },
  row(d) {
    const i = M.rows.flatMap(r => r.its).find(x => x.id === +d.id), p = i.pid && M.pays[i.pid];
    const attach = cam => pickImage(cam).then(async url => { if (url) { await DB.setProof(p.id, url); toast('تم حفظ الإثبات'); render(); } });
    if (!p) return sheet(`الشهر ${i.n}`, [['＋ تسجيل تحصيل لهذا الشهر', () => { PRE = i.id; location.hash = '#/pay/' + i.cid; }, '']]);
    const items = [];
    if (p.proof) items.push(['عرض الإثبات', () => viewImg(p.proof)]);
    items.push(['📷 إرفاق إثبات بالكاميرا', () => attach(true)], ['🖼 إرفاق إثبات من المعرض', () => attach(false)]);
    items.push(['إلغاء هذا التحصيل', async () => {
      const ms_ = M.rows.find(r => r.id === i.cid).its.filter(x => x.pid === p.id).map(x => x.n).join('، ');
      if (!confirm(`سيُلغى التحصيل الذي يغطي الأشهر: ${ms_}\nوتعود غير محصّلة ويُحذف إثباتها. المتابعة؟`)) return;
      await DB.deletePayment(p.id); toast('أُلغي التحصيل'); reschedule(); render();
    }, 'danger']);
    sheet(`الشهر ${i.n} — ${chipText(i)}`, items);
  },
  cimg(d) {
    const r = M.byId[+d.id], set = cam => pickImage(cam).then(async url => { if (url) { await DB.setImage(r.id, url); toast('تم حفظ صورة العقد'); render(); } });
    const items = r.image ? [['عرض صورة العقد', () => viewImg(r.image)]] : [];
    sheet('صورة العقد', [...items, ['📷 التقاط صورة العقد', () => set(true)], ['🖼 اختيار من المعرض', () => set(false)]]);
  },
  async delc(d) {
    const r = M.byId[+d.id];
    if (!confirm(`سيُحذف العقد «${r.title}» نهائيًا مع جدول أشهره وكل تحصيلاته وصوره.\nلا يمكن التراجع. هل أنت متأكد؟`)) return;
    await DB.deleteContract(r.id); toast('حُذف العقد'); reschedule(); location.replace('#/');
  },
  async saveSet() {
    const g = Math.max(0, Math.floor(num($('#s-grace').value) || 0)), h = Math.min(23, Math.max(0, Math.floor(num($('#s-hour').value) || 0)));
    await DB.setSetting('grace', g); await DB.setSetting('hour', h); await DB.setSetting('notify', $('#s-notify').checked ? 1 : 0);
    await reschedule(); toast('تم حفظ الإعدادات'); render();
  },
  async enableN() {
    const p = await enableNotifs();
    toast(p === 'granted' ? 'تم تفعيل الإشعارات' : p === 'web' ? 'الإشعارات تعمل في تطبيق الهاتف فقط' : 'الإذن مرفوض — فعّله من إعدادات الهاتف');
    render();
  },
  async testN() {
    if (!isNative()) return toast('الإشعارات تعمل في تطبيق الهاتف فقط');
    const LN = plug('LocalNotifications');
    if ((await LN.checkPermissions()).display !== 'granted') return toast('فعّل إذن الإشعارات أولًا');
    await LN.createChannel(CH);
    await LN.schedule({ notifications: [{ id: 9999, title: 'إشعار تجريبي', body: 'هكذا ستظهر تنبيهات التحصيل المتأخر.', channelId: CH.id, schedule: { at: new Date(Date.now() + 5000), allowWhileIdle: true } }] });
    toast('سيصلك إشعار تجريبي بعد 5 ثوانٍ');
  },
  async exp() {
    const d = await DB.all(), st = await DB.settings(), name = `tahseel-backup-${TODAY()}.json`;
    const json = JSON.stringify({ v: 1, c: d.c, i: d.i, p: d.p, st });
    if (isNative()) {
      const w = await plug('Filesystem').writeFile({ path: name, data: json, directory: 'CACHE', encoding: 'utf8' });
      await plug('Share').share({ title: name, url: w.uri, dialogTitle: 'حفظ النسخة الاحتياطية' });
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = name; a.click();
    }
  },
  imp() { const el = $('#restore'); el.value = ''; el.click(); },
};
const chipText = i => monthStatus(i, M, +ST.grace || 0)[0];

async function restoreFile(file) {
  try {
    const o = JSON.parse(await file.text());
    if (o.v !== 1 || !Array.isArray(o.c) || !Array.isArray(o.i) || !Array.isArray(o.p)) throw new Error('bad');
    if (!confirm(`سيُستبدل كل ما في التطبيق الآن بالنسخة (${o.c.length} عقد). المتابعة؟`)) return;
    await DB.importAll(o); toast('تم استيراد النسخة'); reschedule(); location.replace('#/'); render();
  } catch (e) { toast('الملف ليس نسخة احتياطية صالحة'); }
}

// ───────────── التوجيه ─────────────
const ROUTES = [[/^#\/add$/, addScreen], [/^#\/c\/(\d+)$/, contractScreen], [/^#\/pay\/(\d+)$/, payScreen], [/^#\/late$/, lateScreen], [/^#\/settings$/, settingsScreen]];
async function render() {
  const h = location.hash || '#/';
  const [st, d] = await Promise.all([DB.settings(), DB.all()]);
  ST = st; M = model(d, st);
  let fn = homeScreen, a = [];
  for (const [re, f] of ROUTES) { const x = h.match(re); if (x) { fn = f; a = x.slice(1).map(Number); break; } }
  const out = fn(M, st, ...a);
  $('#ttl').textContent = out.t; $('#back').hidden = !!out.root;
  $('#view').innerHTML = out.h;
  $('#sheet').hidden = true; $('#viewer').hidden = true;
  window.scrollTo(0, 0);
  if (out.after) await out.after();
}

async function init() {
  await DB.open();
  $('#back').onclick = () => history.back();
  $('#viewer').onclick = () => { $('#viewer').hidden = true; };
  $('#restore').onchange = e => { if (e.target.files[0]) restoreFile(e.target.files[0]); };
  $('#view').addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && A[b.dataset.act]) A[b.dataset.act](b.dataset); });
  $('#view').addEventListener('input', e => { if (['f-start', 'f-end', 'f-amt'].includes(e.target.id)) calcAdd(); });
  $('#view').addEventListener('change', e => { if (e.target.classList.contains('mchk')) calcTot(); });
  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!/^#\/(add|pay)/.test(location.hash)) render();   // لا نُعيد رسم النماذج حتى لا تضيع بيانات الإدخال
    reschedule();
  });
  if (isNative()) plug('LocalNotifications').addListener('localNotificationActionPerformed', () => { location.hash = '#/late'; });
  await render();
  reschedule();
}
window.__app = { DB, model, buildPlan, countMonths, addMonths, render, A, reschedule, draft };
init();
