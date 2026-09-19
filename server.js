import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./src/store.js";
import * as rules from "./src/rules.js";

// 请求入口模块：HTTP 路由、请求解析与页面渲染。
// 配胶规则在 src/rules.js，记录存储在 src/store.js。

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultDbPath = join(__dirname, "data", "glue-review.json");
const port = Number(process.env.PORT || 3037);

const VATS = ["调胶缸-1", "调胶缸-2", "调胶缸-3", "调胶缸-4"];

const seed = {
  seq: 1003,
  batches: [
    {
      id: "PB-1003",
      requestId: null,
      smokeBatch: "桐油烟-2026-09B",
      vat: "调胶缸-2",
      glueBatch: "骨胶液-0912",
      sieveResidue: 2.4,
      ash: 0.55,
      glueViscosity: 24.9,
      status: "待复核",
      viscosityChecks: [
        { operator: "陈师傅", seconds: 24.6, inRange: true, at: "2026-09-18T06:10:00.000Z" }
      ],
      release: null,
      history: [
        { at: "2026-09-18T05:40:00.000Z", event: "创建配胶", note: "绑定烟料批次桐油烟-2026-09B、调胶缸调胶缸-2、胶液批次骨胶液-0912，进入待复核" },
        { at: "2026-09-18T06:10:00.000Z", event: "粘度复核", note: "陈师傅实测24.6秒，在25±2秒内" }
      ],
      createdAt: "2026-09-18T05:40:00.000Z"
    },
    {
      id: "PB-1002",
      requestId: null,
      smokeBatch: "松烟-2026-09A",
      vat: "调胶缸-3",
      glueBatch: "明胶液-0911",
      sieveResidue: 3.6,
      ash: 0.92,
      glueViscosity: 26.3,
      status: "退回筛料",
      viscosityChecks: [],
      release: null,
      history: [
        { at: "2026-09-17T08:20:00.000Z", event: "退回筛料", note: "筛余率3.6%或灰分0.92%超限，只能退回筛料，不得进入成型" }
      ],
      createdAt: "2026-09-17T08:20:00.000Z"
    },
    {
      id: "PB-1001",
      requestId: null,
      smokeBatch: "黄山松烟-2026-09A",
      vat: "调胶缸-1",
      glueBatch: "明胶液-0910",
      sieveResidue: 1.9,
      ash: 0.48,
      glueViscosity: 25.1,
      status: "可成型",
      viscosityChecks: [
        { operator: "陈师傅", seconds: 24.8, inRange: true, at: "2026-09-16T07:05:00.000Z" },
        { operator: "李师傅", seconds: 25.7, inRange: true, at: "2026-09-16T07:20:00.000Z" }
      ],
      release: { at: "2026-09-16T07:20:00.000Z", operators: ["陈师傅", "李师傅"] },
      history: [
        { at: "2026-09-16T06:30:00.000Z", event: "创建配胶", note: "绑定烟料批次黄山松烟-2026-09A、调胶缸调胶缸-1、胶液批次明胶液-0910，进入待复核" },
        { at: "2026-09-16T07:05:00.000Z", event: "粘度复核", note: "陈师傅实测24.8秒，在25±2秒内" },
        { at: "2026-09-16T07:20:00.000Z", event: "粘度复核", note: "李师傅实测25.7秒，在25±2秒内" },
        { at: "2026-09-16T07:20:00.000Z", event: "放行", note: "陈师傅、李师傅两人复核均在25±2秒，放行进入成型" }
      ],
      createdAt: "2026-09-16T06:30:00.000Z"
    }
  ]
};

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.status = 400;
    throw error;
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

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>烟料配胶与成型复核台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:12px; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:120px; overflow:auto; font-size:13px; } .warn { color:var(--warn); font-weight:700; } .ok { color:var(--accent); font-weight:700; }
    .hint { color:var(--muted); font-size:12px; margin-top:10px; line-height:1.6; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>烟料配胶与成型复核台</h1><div class="meta">配胶绑定烟料批次 · 调胶缸 · 胶液批次，双人粘度复核合格后放行成型</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm">
        <h2>提交配胶</h2>
        <label>烟料批次</label><input name="smokeBatch" required placeholder="如 黄山松烟-2026-09A">
        <label>调胶缸</label><select name="vat">${VATS.map(v => "<option>" + v + "</option>").join("")}</select>
        <label>胶液批次</label><input name="glueBatch" required placeholder="如 明胶液-0918">
        <label>烟料筛余率（%，超过3%退回筛料）</label><input name="sieveResidue" type="number" step="0.01" min="0" required>
        <label>烟料灰分（%，超过0.8%退回筛料）</label><input name="ash" type="number" step="0.01" min="0" required>
        <label>胶液粘度登记（秒）</label><input name="glueViscosity" type="number" step="0.1" min="0" required>
        <button>提交配胶</button>
        <div class="hint">同一调胶缸未完成前再次提交将返回409且不落库；重复或并发提交沿用首次结果。</div>
      </form>
      <form id="checkForm" style="margin-top:14px">
        <h2>粘度复核（两人各测一次）</h2>
        <label>配胶批次（仅待复核）</label><select name="id" id="checkSelect"></select>
        <label>操作人</label><input name="operator" required placeholder="如 陈师傅">
        <label>实测粘度（秒，25±2合格）</label><input name="seconds" type="number" step="0.1" min="0" required>
        <button>提交复核</button>
        <div class="hint">两次都在25±2秒且操作人不同，批次自动放行进入可成型。</div>
      </form>
      <form id="adjustForm" style="margin-top:14px">
        <h2>调整烟料 / 胶液批次</h2>
        <label>配胶批次</label><select name="id" id="adjustSelect"></select>
        <label>新烟料批次</label><input name="smokeBatch" placeholder="留空表示不调整">
        <label>新胶液批次</label><input name="glueBatch" placeholder="留空表示不调整">
        <button>提交调整</button>
        <div class="hint">调整后旧放行立即失效并留档，批次回到待复核，需重新双人复核。</div>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option></select><input id="search" placeholder="搜索批次 / 调胶缸 / 操作人"></div>
      <div class="panel"><h2>配胶记录（旧结论留档于历史，不计入可成型）</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const STATUSES = ["待复核", "可成型", "退回筛料"];
    const createForm = document.querySelector("#createForm");
    const checkForm = document.querySelector("#checkForm");
    const adjustForm = document.querySelector("#adjustForm");
    const cards = document.querySelector("#cards");
    const statsEl = document.querySelector("#stats");
    const checkSelect = document.querySelector("#checkSelect");
    const adjustSelect = document.querySelector("#adjustSelect");
    const statusFilter = document.querySelector("#statusFilter");
    let batches = [];
    let stats = {};
    let requestId = crypto.randomUUID();

    statusFilter.innerHTML = '<option value="">全部状态</option>' + STATUSES.map(s => "<option>" + s + "</option>").join("");

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.message || data.error || "请求失败"); err.status = res.status; throw err; }
      return data;
    }
    async function load() {
      const [list, nextStats] = await Promise.all([api("/api/batches"), api("/api/stats")]);
      batches = list;
      stats = nextStats;
      render();
    }
    function render() {
      statsEl.innerHTML = STATUSES.map(s => '<div class="stat"><span>' + s + "</span><strong>" + (stats[s] || 0) + "</strong></div>").join("");
      const pending = batches.filter(b => b.status === "待复核");
      const adjustable = batches.filter(b => b.status !== "退回筛料");
      checkSelect.innerHTML = pending.map(b => '<option value="' + b.id + '">' + esc(b.id + " · " + b.vat + " · " + b.smokeBatch) + "</option>").join("") || '<option value="">暂无待复核批次</option>';
      adjustSelect.innerHTML = adjustable.map(b => '<option value="' + b.id + '">' + esc(b.id + " · " + b.vat + " · " + b.status) + "</option>").join("") || '<option value="">暂无可调整批次</option>';
      const status = statusFilter.value;
      const q = document.querySelector("#search").value.trim();
      const visible = batches.filter(b => (!status || b.status === status) && (!q || JSON.stringify(b).includes(q)));
      cards.innerHTML = visible.map(cardHtml).join("") || '<div class="meta">暂无记录</div>';
    }
    function cardHtml(b) {
      const checks = b.viscosityChecks.map(c => "<div>" + esc(c.operator) + " 实测 " + c.seconds + " 秒 " + (c.inRange ? '<span class="ok">合格</span>' : '<span class="warn">超差</span>') + "</div>").join("");
      const release = b.release ? '<div class="ok">已放行：' + esc(b.release.operators.join("、")) + " 双人复核合格</div>" : "";
      const history = (b.history || []).slice(-6).map(h => "<div>" + esc(h.event) + "：" + esc(h.note) + "</div>").join("");
      return '<article class="card"><h3>' + esc(b.id) + " · " + esc(b.vat) + '</h3><span class="pill">' + esc(b.status) + "</span>"
        + "<div><b>烟料批次</b> " + esc(b.smokeBatch) + "</div>"
        + "<div><b>胶液批次</b> " + esc(b.glueBatch) + "</div>"
        + '<div class="meta">筛余率 ' + b.sieveResidue + "% · 灰分 " + b.ash + "% · 登记粘度 " + b.glueViscosity + " 秒</div>"
        + '<div class="logs">' + (checks || "暂无复核记录") + release + "</div>"
        + '<div class="logs meta">' + history + "</div></article>";
    }
    createForm.onsubmit = async event => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(createForm).entries());
      payload.requestId = requestId;
      try {
        const result = await api("/api/batches", { method: "POST", body: JSON.stringify(payload) });
        requestId = crypto.randomUUID();
        createForm.reset();
        await load();
        alert((result.deduplicated ? "重复提交，已沿用首次结果：" : "已提交配胶：") + result.id + "（" + result.status + "）");
      } catch (err) {
        alert(err.status === 409 ? "该调胶缸有未完成的配胶（409），本次未落库" : err.message);
        await load();
      }
    };
    checkForm.onsubmit = async event => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(checkForm).entries());
      if (!payload.id) return alert("暂无待复核的批次");
      try {
        const result = await api("/api/batches/" + payload.id + "/checks", { method: "POST", body: JSON.stringify(payload) });
        checkForm.reset();
        await load();
        alert(result.status === "可成型" ? "双人复核合格，已放行进入可成型" : "已登记复核，当前状态：" + result.status);
      } catch (err) { alert(err.message); }
    };
    adjustForm.onsubmit = async event => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(adjustForm).entries());
      if (!payload.id) return alert("暂无可调整的批次");
      const patch = {};
      if (payload.smokeBatch.trim()) patch.smokeBatch = payload.smokeBatch.trim();
      if (payload.glueBatch.trim()) patch.glueBatch = payload.glueBatch.trim();
      if (!Object.keys(patch).length) return alert("请填写要调整的新批次");
      try {
        await api("/api/batches/" + payload.id, { method: "PATCH", body: JSON.stringify(patch) });
        adjustForm.reset();
        await load();
        alert("已调整，旧结论留档，批次回到待复核");
      } catch (err) { alert(err.message); }
    };
    statusFilter.onchange = render;
    document.querySelector("#search").oninput = render;
    document.querySelector("#reload").onclick = load;
    load();
  </script>
</body>
</html>`;
}

export async function createApp(options = {}) {
  const store = createStore(options.dbPath || process.env.DB_PATH || defaultDbPath, options.seed || seed);
  await store.init();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const db = store.getDb();

      if (req.method === "GET" && url.pathname === "/") return html(res, page());
      if (req.method === "GET" && url.pathname === "/api/batches") return send(res, 200, db.batches.map(rules.summarize));
      if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, rules.computeStats(db));

      if (req.method === "POST" && url.pathname === "/api/batches") {
        const result = rules.createBatch(db, await body(req));
        if (result.persist) await store.save();
        return send(res, result.status, result.body);
      }

      const detail = url.pathname.match(/^\/api\/batches\/([^/]+)$/);
      if (detail && req.method === "GET") {
        const batch = db.batches.find(b => b.id === detail[1]);
        return batch ? send(res, 200, rules.summarize(batch)) : send(res, 404, { error: "batch_not_found" });
      }
      if (detail && req.method === "PATCH") {
        const result = rules.adjustBatch(db, detail[1], await body(req));
        if (result.persist) await store.save();
        return send(res, result.status, result.body);
      }

      const check = url.pathname.match(/^\/api\/batches\/([^/]+)\/checks$/);
      if (check && req.method === "POST") {
        const result = rules.addViscosityCheck(db, check[1], await body(req));
        if (result.persist) await store.save();
        return send(res, result.status, result.body);
      }

      send(res, 404, { error: "not_found" });
    } catch (error) {
      send(res, error.status || 500, { error: error.message });
    }
  });
  return server;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = await createApp();
  server.listen(port, () => console.log("烟料配胶与成型复核台 listening on http://localhost:" + port));
}
