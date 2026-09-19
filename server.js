import http from "node:http";
import { store } from "./store.js";
import {
  createGlueService,
  summarize,
  view,
  STATUS,
  STATUSES,
  SIEVE_LIMIT,
  ASH_LIMIT,
  VISCOSITY_MID,
  VISCOSITY_TOLERANCE,
  RuleError
} from "./rules.js";

// 请求入口模块：HTTP 路由与页面；配胶规则在 rules.js，记录存储在 store.js。
const port = Number(process.env.PORT || 3037);
const glue = createGlueService(store);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RuleError(400, "bad_json", "请求体不是合法 JSON");
  }
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") return html(res, page());

    if (req.method === "GET" && path === "/api/batches") {
      return send(res, 200, await glue.list());
    }
    if (req.method === "GET" && path === "/api/stats") {
      const db = await store.read();
      return send(res, 200, summarize(db.batches));
    }
    if (req.method === "POST" && path === "/api/batches") {
      const result = await glue.create(await body(req));
      // 重复或并发提交沿用首次结果：返回首次记录（200），不产生新记录
      return send(res, result.idempotent ? 200 : 201, view(result.batch));
    }
    const measure = path.match(/^\/api\/batches\/([^/]+)\/measurements$/);
    if (measure && req.method === "POST") {
      const batch = await glue.addMeasurement(measure[1], await body(req));
      return send(res, 201, view(batch));
    }
    const recheck = path.match(/^\/api\/batches\/([^/]+)\/recheck$/);
    if (recheck && req.method === "POST") {
      await body(req);
      const batch = await glue.recheck(recheck[1]);
      return send(res, 200, view(batch));
    }
    const one = path.match(/^\/api\/batches\/([^/]+)$/);
    if (one && req.method === "PATCH") {
      const batch = await glue.adjust(one[1], await body(req));
      return send(res, 200, view(batch));
    }
    return send(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof RuleError) {
      return send(res, error.status, { error: error.code, message: error.message });
    }
    return send(res, 500, { error: "internal_error", message: error.message });
  }
});

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>烟料配胶与成型复核台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --hold:#8a6d2a; --ok:#3c6b3c; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 10px; font-size:17px; } h3 { margin:0; font-size:16px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:15px; }
    label { display:block; margin:9px 0 4px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.warn { background:var(--warn); } button.hold { background:var(--hold); }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:23px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; align-items:center; } .toolbar select,.toolbar input { width:auto; min-width:150px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:6px; }
    .meta { color:var(--muted); font-size:12.5px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; justify-self:start; }
    .pill.可成型 { color:var(--ok); border-color:var(--ok); } .pill.退回筛料 { color:var(--warn); border-color:var(--warn); } .pill.复核未过 { color:var(--hold); border-color:var(--hold); }
    .logs { border-top:1px solid var(--line); padding-top:7px; max-height:96px; overflow:auto; } .flag { color:var(--warn); font-weight:700; }
    #flash { margin:0 28px; padding:10px 14px; border-radius:6px; display:none; font-size:13.5px; } #flash.ok { display:block; background:#e6f0e1; color:var(--ok); } #flash.err { display:block; background:#f5e2dd; color:var(--warn); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} #flash{margin:0 16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>烟料配胶与成型复核台</h1><div class="meta">烟料批次绑定调胶缸与胶液批次 · 筛余/灰分门限 · 双人双测粘度放行</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <section>
      <form id="createForm">
        <h2>配胶登记</h2>
        <label>烟料批次（必填）</label><input name="smokeBatch" required placeholder="如 YAN-2106">
        <label>调胶缸（必填，同缸未完成禁重复提交）</label><input name="vat" required placeholder="如 GANG-甲-01">
        <label>胶液批次（必填）</label><input name="glueBatch" required placeholder="如 JIAO-306">
        <div class="row">
          <div><label>筛余率 %（&gt;${SIEVE_LIMIT}% 退回筛料）</label><input name="sieveResidue" type="number" step="0.01" min="0" required></div>
          <div><label>灰分 %（&gt;${ASH_LIMIT}% 退回筛料）</label><input name="ash" type="number" step="0.01" min="0" required></div>
        </div>
        <label>胶液粘度 秒（登记值）</label><input name="glueViscosity" type="number" step="0.1" min="0" required>
        <div style="margin-top:12px"><button>提交配胶</button></div>
      </form>
      <form id="measureForm" style="margin-top:14px">
        <h2>成型粘度复核（两人各测一次）</h2>
        <label>选择配胶单</label><select name="id" id="batchSelect"></select>
        <div class="row">
          <div><label>操作人</label><input name="operator" required placeholder="与首次不同的操作人"></div>
          <div><label>粘度 秒（${VISCOSITY_MID}±${VISCOSITY_TOLERANCE} 放行）</label><input name="viscosity" type="number" step="0.1" min="0" required></div>
        </div>
        <div style="margin-top:12px"><button>提交测量</button></div>
      </form>
      <form id="adjustForm" class="panel" style="margin-top:14px">
        <h2>调整烟料/胶液批次（旧放行立即失效）</h2>
        <label>选择配胶单</label><select name="id" id="adjustSelect"></select>
        <div class="row">
          <div><label>新烟料批次</label><input name="smokeBatch" required></div>
          <div><label>新胶液批次</label><input name="glueBatch" required></div>
        </div>
        <div class="row">
          <div><label>新筛余率 %</label><input name="sieveResidue" type="number" step="0.01" min="0"></div>
          <div><label>新灰分 %</label><input name="ash" type="number" step="0.01" min="0"></div>
        </div>
        <label>新胶液粘度 秒</label><input name="glueViscosity" type="number" step="0.1" min="0">
        <div style="margin-top:12px"><button class="warn">调整并回到待复核</button></div>
      </form>
    </section>
    <section>
      <div id="flash"></div>
      <div class="stats" id="stats" style="margin-top:14px"></div>
      <div class="toolbar">
        <select id="statusFilter"><option value="">全部状态</option>${STATUSES.map(s => '<option>' + s + '</option>').join('')}</select>
        <label style="margin:0;display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="formableOnly" style="width:auto"> 仅看可成型列表</label>
        <input id="search" placeholder="搜索配胶单/烟料/调胶缸/胶液">
      </div>
      <div class="panel">
        <h2>配胶记录</h2>
        <div class="meta" style="margin-bottom:10px">筛余率超 ${SIEVE_LIMIT}% 或灰分超 ${ASH_LIMIT}% 只能退回筛料；两次粘度均在 ${VISCOSITY_MID}±${VISCOSITY_TOLERANCE} 秒且操作人不同才放行；调整批次后旧结论留档但不进入可成型列表。</div>
        <div class="grid" id="cards"></div>
      </div>
    </section>
  </main>
  <script>
    const STATUSES = ${JSON.stringify(STATUSES)};
    const SIEVE_LIMIT = ${SIEVE_LIMIT}, ASH_LIMIT = ${ASH_LIMIT}, MID = ${VISCOSITY_MID}, TOL = ${VISCOSITY_TOLERANCE};
    const createForm = document.querySelector('#createForm');
    const measureForm = document.querySelector('#measureForm');
    const adjustForm = document.querySelector('#adjustForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const batchSelect = document.querySelector('#batchSelect');
    const adjustSelect = document.querySelector('#adjustSelect');
    const flashEl = document.querySelector('#flash');
    let batches = [];
    function esc(v){ return String(v ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
    function flash(text, ok){ flashEl.textContent = text; flashEl.className = ok ? 'ok' : 'err'; }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{'Content-Type':'application/json'} } : options);
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data.message || data.error || '请求失败'), { status: res.status, code: data.error });
      return data;
    }
    function computeStats(list) {
      const stats = Object.fromEntries(STATUSES.map(s => [s, 0]));
      for (const b of list) { if (stats[b.status] !== undefined) stats[b.status] += 1; }
      stats.全部 = list.length;
      return stats;
    }
    function fmt(at){ return (at || '').slice(0, 16).replace('T', ' '); }
    function cardHtml(b) {
      const badSieve = b.sieveResidue > SIEVE_LIMIT, badAsh = b.ash > ASH_LIMIT;
      const meas = b.measurements.map((m, i) => '<div class="meta">' + (i === 0 ? '首测' : '复测') + '：' + esc(m.operator) + ' · ' + esc(m.viscosity) + '秒 · ' + fmt(m.at) + '</div>').join('') || '<div class="meta">尚无粘度测量</div>';
      const archives = b.history.map(h => '<div class="meta">留档[' + esc(h.reason) + ' ' + fmt(h.at) + ']：旧状态 ' + esc(h.conclusion.status) + '，不计入可成型</div>').join('');
      const logs = b.logs.slice(-4).map(l => '<div class="meta">· ' + esc(l.step) + '（' + fmt(l.at) + '）' + esc(l.note) + '</div>').join('');
      const canRecheck = b.status === '复核未过';
      const measureHint = b.status === '待复核' && b.measurements.length === 1 ? ' <span class="meta">需另一位操作人复测</span>' : '';
      return '<article class="card">'
        + '<h3>' + esc(b.id) + ' <span class="meta">v' + b.revision + '</span></h3>'
        + '<span class="pill ' + b.status + '">' + b.status + (b.formable ? ' · 可成型' : '') + '</span>'
        + '<div class="meta">烟料批次 <b>' + esc(b.smokeBatch) + '</b> · 调胶缸 <b>' + esc(b.vat) + '</b> · 胶液 <b>' + esc(b.glueBatch) + '</b></div>'
        + '<div>筛余率 <span class="' + (badSieve ? 'flag' : '') + '">' + esc(b.sieveResidue) + '%</span>　灰分 <span class="' + (badAsh ? 'flag' : '') + '">' + esc(b.ash) + '%</span>　胶液粘度 ' + esc(b.glueViscosity) + '秒</div>'
        + '<div>成型粘度复核：' + meas + archives + measureHint + '</div>'
        + (canRecheck ? '<button class="hold" data-recheck="' + esc(b.id) + '">申请重新复核（回到待复核）</button>' : '')
        + '<div class="logs">' + logs + '</div>'
        + '</article>';
    }
    function render() {
      const stats = computeStats(batches);
      statsEl.innerHTML = [['全部', stats.全部], ...STATUSES.map(s => [s, stats[s]])]
        .map(([k, v]) => '<div class="stat"><span>' + k + '</span><strong>' + v + '</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const formableOnly = document.querySelector('#formableOnly').checked;
      const visible = batches.filter(b =>
        (!status || b.status === status)
        && (!formableOnly || b.formable)
        && (!q || [b.id, b.smokeBatch, b.vat, b.glueBatch].some(v => String(v).includes(q))));
      cards.innerHTML = visible.map(cardHtml).join('') || '<div class="meta">没有符合条件的配胶记录</div>';
      const options = batches.filter(b => b.status === '待复核').map(b => '<option value="' + esc(b.id) + '">' + esc(b.id) + ' · ' + esc(b.vat) + ' · 已测' + b.measurements.length + '次</option>').join('');
      batchSelect.innerHTML = options || '<option value="">（待复核中无可测配胶单）</option>';
      adjustSelect.innerHTML = batches.map(b => '<option value="' + esc(b.id) + '">' + esc(b.id) + ' · ' + esc(b.status) + '</option>').join('');
      document.querySelectorAll('[data-recheck]').forEach(btn => btn.onclick = async () => {
        try { await api('/api/batches/' + encodeURIComponent(btn.dataset.recheck) + '/recheck', { method: 'POST', body: '{}' }); flash('已回到待复核，旧结论留档', true); await load(); }
        catch (e) { flash(e.message, false); }
      });
    }
    async function load() { batches = await api('/api/batches'); render(); }
    createForm.onsubmit = async e => {
      e.preventDefault();
      try {
        const b = await api('/api/batches', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) });
        flash('配胶单 ' + b.id + ' 已登记：' + b.status, true); createForm.reset(); await load();
      } catch (err) { flash('提交失败（' + err.status + '）：' + err.message + (err.status === 409 ? '，数据未落库' : ''), false); }
    };
    measureForm.onsubmit = async e => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(measureForm).entries());
      if (!fd.id) return flash('没有待复核的配胶单', false);
      try {
        const b = await api('/api/batches/' + encodeURIComponent(fd.id) + '/measurements', { method: 'POST', body: JSON.stringify({ operator: fd.operator, viscosity: fd.viscosity }) });
        flash(b.status === '可成型' ? b.id + ' 双人双测通过，已放行进入可成型列表' : b.id + ' 测量已登记：' + b.status, b.status === '可成型');
        measureForm.reset(); await load();
      } catch (err) { flash('测量被拒绝（' + err.status + '）：' + err.message, false); }
    };
    adjustForm.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(adjustForm);
      const id = fd.get('id');
      const patch = {};
      for (const k of ['smokeBatch','glueBatch','sieveResidue','ash','glueViscosity']) {
        const v = String(fd.get(k) ?? '').trim();
        if (v !== '') patch[k] = v;
      }
      try {
        const b = await api('/api/batches/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) });
        flash(b.id + ' 已调整，旧放行结论失效留档，当前：' + b.status, true); adjustForm.reset(); await load();
      } catch (err) { flash('调整被拒绝（' + err.status + '）：' + err.message, false); }
    };
    document.querySelector('#statusFilter').onchange = render;
    document.querySelector('#formableOnly').onchange = render;
    document.querySelector('#search').oninput = render;
    document.querySelector('#reload').onclick = async () => { await load(); flash('已从存储刷新，列表与统计一致', true); };
    load();
  </script>
</body>
</html>`;
}

server.listen(port, () => console.log("烟料配胶与成型复核台 listening on http://localhost:" + port));
