const base = "http://localhost:3037";
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("PASS:", msg); } else { fail++; console.log("FAIL:", msg); } }
async function req(method, path, payload) {
  const res = await fetch(base + path, { method, headers: payload !== undefined ? { "Content-Type": "application/json" } : undefined, body: payload !== undefined ? JSON.stringify(payload) : undefined });
  const data = await res.json();
  return { status: res.status, data };
}

// 0. 种子统计
let r = await req("GET", "/api/stats");
ok(r.status === 200 && r.data.total === 5 && r.data["可成型"] === 2 && r.data["待复核"] === 1 && r.data["退回筛料"] === 1 && r.data["复核未过"] === 1, "种子统计口径正确 " + JSON.stringify(r.data));

// 1. 缺少绑定 -> 400
r = await req("POST", "/api/batches", { smokeBatch: "Y", glueBatch: "J", sieveResidue: 1, ash: 0.2, glueViscosity: 25 });
ok(r.status === 400 && r.data.error === "missing_field", "缺少调胶缸返回 400");

// 2. 正常登记 -> 201 待复核，边界值 3.0 / 0.8 不触发退回
r = await req("POST", "/api/batches", { smokeBatch: "YAN-T1", vat: "GANG-T1", glueBatch: "JIAO-T1", sieveResidue: 3.0, ash: 0.8, glueViscosity: 25.0 });
ok(r.status === 201 && r.data.status === "待复核", "正常配胶 201 待复核，筛余3.0/灰分0.8边界放行: " + r.status);
const id1 = r.data.id;

// 3. 同缸相同内容重复提交 -> 200 幂等，沿用首次结果
r = await req("POST", "/api/batches", { smokeBatch: "YAN-T1", vat: "GANG-T1", glueBatch: "JIAO-T1", sieveResidue: 3.0, ash: 0.8, glueViscosity: 25.0 });
ok(r.status === 200 && r.data.id === id1, "重复提交沿用首次结果 200: " + r.status);

// 4. 同缸未完成、内容不同 -> 409 不落库
r = await req("POST", "/api/batches", { smokeBatch: "YAN-T1", vat: "GANG-T1", glueBatch: "JIAO-OTHER", sieveResidue: 1, ash: 0.2, glueViscosity: 25 });
ok(r.status === 409 && r.data.error === "vat_busy", "同缸未完成不同内容返回 409: " + r.status);

// 5. 筛余率超 3% -> 退回筛料
r = await req("POST", "/api/batches", { smokeBatch: "YAN-T2", vat: "GANG-T2", glueBatch: "JIAO-T2", sieveResidue: 3.01, ash: 0.5, glueViscosity: 25 });
ok(r.status === 201 && r.data.status === "退回筛料", "筛余率 3.01% 退回筛料");
const idReject = r.data.id;
// 退回筛料的缸算已完成？规则：退回筛料不得进入成型，缸占用应释放，新缸号 anyway。测量被拒绝：
r = await req("POST", `/api/batches/${idReject}/measurements`, { operator: "甲", viscosity: 25 });
ok(r.status === 409 && r.data.error === "rejected", "退回筛料不得测量放行 409");

// 6. 灰分超 0.8% -> 退回筛料
r = await req("POST", "/api/batches", { smokeBatch: "YAN-T3", vat: "GANG-T3", glueBatch: "JIAO-T3", sieveResidue: 1, ash: 0.81, glueViscosity: 25 });
ok(r.status === 201 && r.data.status === "退回筛料", "灰分 0.81% 退回筛料");

// 7. 双人双测：边界 23/27 且操作人不同 -> 可成型
r = await req("POST", `/api/batches/${id1}/measurements`, { operator: "甲", viscosity: 23 });
ok(r.status === 201 && r.data.status === "待复核" && r.data.measurements.length === 1, "首次测量 23秒 仍待复核");
r = await req("POST", `/api/batches/${id1}/measurements`, { operator: "乙", viscosity: 27 });
ok(r.status === 201 && r.data.status === "可成型", "复测 27秒 边界通过，双人双测放行");
const formableBefore = (await req("GET", "/api/batches")).data.filter(b => b.formable).map(b => b.id);

// 8. 已放行再测 -> 409
r = await req("POST", `/api/batches/${id1}/measurements`, { operator: "丙", viscosity: 25 });
ok(r.status === 409 && r.data.error === "released", "已放行再次测量 409");

// 9. 第二次超范围 -> 复核未过；可申请重新复核
r = await req("POST", "/api/batches", { smokeBatch: "YAN-T4", vat: "GANG-T4", glueBatch: "JIAO-T4", sieveResidue: 2, ash: 0.5, glueViscosity: 25 });
const id2 = r.data.id;
await req("POST", `/api/batches/${id2}/measurements`, { operator: "甲", viscosity: 25 });
r = await req("POST", `/api/batches/${id2}/measurements`, { operator: "乙", viscosity: 22.9 });
ok(r.data.status === "复核未过", "第二次 22.9 秒复核未过");
r = await req("POST", `/api/batches/${id2}/measurements`, { operator: "丙", viscosity: 25 });
ok(r.status === 409 && r.data.error === "review_failed", "复核未过状态直接测量 409");
// 此时同缸换内容提交仍 409（未完成）
r = await req("POST", "/api/batches", { smokeBatch: "YAN-T4X", vat: "GANG-T4", glueBatch: "JIAO-T4X", sieveResidue: 1, ash: 0.1, glueViscosity: 25 });
ok(r.status === 409, "复核未过仍占用调胶缸，再提交 409");
r = await req("POST", `/api/batches/${id2}/recheck`, {});
ok(r.status === 200 && r.data.status === "待复核" && r.data.measurements.length === 0 && r.data.history.length === 1, "重新复核回到待复核，旧结论留档");
r = await req("POST", `/api/batches/${id2}/measurements`, { operator: "甲", viscosity: 25 });
ok(r.status === 201, "重新复核后可重新测量");
r = await req("POST", `/api/batches/${id2}/measurements`, { operator: "乙", viscosity: 26 });
ok(r.data.status === "可成型", "重测双人合格后放行");

// 10. 同一操作人不得完成两次
r = await req("POST", "/api/batches", { smokeBatch: "YAN-T5", vat: "GANG-T5", glueBatch: "JIAO-T5", sieveResidue: 2, ash: 0.3, glueViscosity: 25 });
const id3 = r.data.id;
await req("POST", `/api/batches/${id3}/measurements`, { operator: "同一人", viscosity: 25 });
r = await req("POST", `/api/batches/${id3}/measurements`, { operator: "同一人", viscosity: 25 });
ok(r.status === 409 && r.data.error === "same_operator", "同一操作人两次测量 409");

// 11. 调整烟料/胶液批次 -> 旧放行立即失效，回到待复核，旧结论留档，不进可成型列表
r = await req("PATCH", `/api/batches/${id1}`, { smokeBatch: "YAN-NEW", glueBatch: "JIAO-NEW", sieveResidue: 2.2, ash: 0.4, glueViscosity: 25.1 });
ok(r.status === 200 && r.data.status === "待复核" && r.data.revision === 2 && r.data.measurements.length === 0 && r.data.history.length === 1 && r.data.history[0].conclusion.status === "可成型", "调整批次后旧放行失效回待复核，旧结论留档");
const list = (await req("GET", "/api/batches")).data;
const after = list.find(b => b.id === id1);
ok(after.formable === false && !list.filter(b => b.formable).some(b => b.id === id1), "旧放行不计入可成型列表");

// 调整后若指标超标 -> 退回筛料
r = await req("PATCH", `/api/batches/${id1}`, { smokeBatch: "YAN-NEW2", glueBatch: "JIAO-NEW2", sieveResidue: 4, ash: 0.4, glueViscosity: 25 });
ok(r.data.status === "退回筛料" && r.data.history.length === 2, "调整批次后指标超标仍只能退回筛料");

// 调胶缸不可更换
r = await req("PATCH", `/api/batches/${id1}`, { vat: "GANG-OTHER" });
ok(r.status === 400 && r.data.error === "vat_locked", "调胶缸不可更换 400");

// 12. 并发提交：同缸同内容并发两请求 -> 只产生一条
const payload = { smokeBatch: "YAN-C1", vat: "GANG-C1", glueBatch: "JIAO-C1", sieveResidue: 1.5, ash: 0.3, glueViscosity: 25 };
const [c1, c2] = await Promise.all([
  req("POST", "/api/batches", payload),
  req("POST", "/api/batches", payload)
]);
ok([c1.status, c2.status].sort().join(",") === "200,201" && c1.data.id === c2.data.id, "并发同内容提交只落一条并沿用首次结果");
const concCount = (await req("GET", "/api/batches")).data.filter(b => b.vat === "GANG-C1").length;
ok(concCount === 1, "并发后该缸只有一条记录（实际 " + concCount + "）");

// 13. 并发但内容不同 -> 一成功一 409
const p2a = { smokeBatch: "YAN-C2", vat: "GANG-C2", glueBatch: "JIAO-C2A", sieveResidue: 1, ash: 0.1, glueViscosity: 25 };
const p2b = { smokeBatch: "YAN-C2", vat: "GANG-C2", glueBatch: "JIAO-C2B", sieveResidue: 2, ash: 0.2, glueViscosity: 24 };
const [d1, d2] = await Promise.all([req("POST", "/api/batches", p2a), req("POST", "/api/batches", p2b)]);
const statuses = [d1.status, d2.status].sort().join(",");
ok(statuses === "201,409", "并发不同内容：一成一 409（实际 " + statuses + "）");
const conc2 = (await req("GET", "/api/batches")).data.filter(b => b.vat === "GANG-C2");
ok(conc2.length === 1, "被拒并发请求未落库（实际 " + conc2.length + " 条）");

// 14. 列表与统计一致
const finalList = (await req("GET", "/api/batches")).data;
const stats = (await req("GET", "/api/stats")).data;
const recomputed = {};
for (const b of finalList) recomputed[b.status] = (recomputed[b.status] || 0) + 1;
let consistent = stats.total === finalList.length && Object.entries(recomputed).every(([k, v]) => stats[k] === v);
ok(consistent, "统计与列表完全一致: " + JSON.stringify(stats));
const formableList = finalList.filter(b => b.formable).map(b => b.id);
ok(formableList.every(id => finalList.find(b => b.id === id).status === "可成型"), "可成型列表只含当前放行记录，留档旧结论不计入");

// 15. 刷新后一致（重新 GET 仍为同一存储口径）
const again = await req("GET", "/api/batches");
ok(again.data.length === finalList.length, "刷新后记录数一致");

console.log(`\\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
