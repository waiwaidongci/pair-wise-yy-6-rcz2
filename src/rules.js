// 配胶规则模块：配胶批次的校验、状态流转、双人粘度复核放行与批次调整。
// 所有函数只操作传入的 db 对象并返回 { status, body, persist }，
// 由请求入口决定是否落盘（persist=false 时一律不落库）。

export const STATUS = { PENDING: "待复核", MOLDABLE: "可成型", RETURNED: "退回筛料" };
export const STATUSES = [STATUS.PENDING, STATUS.MOLDABLE, STATUS.RETURNED];

// 筛余率超过 3% 或灰分超过 0.8% 只能退回筛料，不得进入成型
export const LIMITS = { sieveResidue: 3, ash: 0.8 };
// 放行粘度区间：25±2 秒
export const VISCOSITY = { target: 25, tolerance: 2 };

export function isViscosityQualified(seconds) {
  return Math.abs(seconds - VISCOSITY.target) <= VISCOSITY.tolerance;
}

export function materialsRejected(sieveResidue, ash) {
  return sieveResidue > LIMITS.sieveResidue || ash > LIMITS.ash;
}

export function summarize(batch) {
  return {
    ...batch,
    checkCount: batch.viscosityChecks.length,
    qualifiedChecks: batch.viscosityChecks.filter(c => c.inRange).length,
    moldable: batch.status === STATUS.MOLDABLE
  };
}

export function computeStats(db) {
  const stats = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const batch of db.batches) {
    if (stats[batch.status] !== undefined) stats[batch.status] += 1;
  }
  return stats;
}

function result(status, body, persist = false) {
  return { status, body, persist };
}

// 提交配胶：绑定烟料批次 + 调胶缸 + 胶液批次，登记筛余率、灰分和胶液粘度
export function createBatch(db, input, now = new Date()) {
  const smokeBatch = String(input.smokeBatch ?? "").trim();
  const vat = String(input.vat ?? "").trim();
  const glueBatch = String(input.glueBatch ?? "").trim();
  if (!smokeBatch) return result(400, { error: "missing_smokeBatch", message: "必须绑定烟料批次" });
  if (!vat) return result(400, { error: "missing_vat", message: "必须绑定调胶缸" });
  if (!glueBatch) return result(400, { error: "missing_glueBatch", message: "必须绑定胶液批次" });
  const sieveResidue = Number(input.sieveResidue);
  const ash = Number(input.ash);
  const glueViscosity = Number(input.glueViscosity);
  if (!Number.isFinite(sieveResidue) || sieveResidue < 0) return result(400, { error: "invalid_sieveResidue", message: "筛余率须为不小于0的数字" });
  if (!Number.isFinite(ash) || ash < 0) return result(400, { error: "invalid_ash", message: "灰分须为不小于0的数字" });
  if (!Number.isFinite(glueViscosity) || glueViscosity <= 0) return result(400, { error: "invalid_glueViscosity", message: "胶液粘度须为大于0的数字" });

  // 重复或并发提交：同一 requestId 直接沿用首次结果，不重复落库
  const requestId = String(input.requestId ?? "").trim();
  if (requestId) {
    const dup = db.batches.find(b => b.requestId === requestId);
    if (dup) return result(200, { ...summarize(dup), deduplicated: true });
  }

  // 同一调胶缸未完成（待复核）前再次提交：409 且不落库
  const active = db.batches.find(b => b.vat === vat && b.status === STATUS.PENDING);
  if (active) {
    return result(409, { error: "vat_busy", vat, activeBatch: active.id, message: `调胶缸${vat}的配胶${active.id}尚未完成，本次提交未落库` });
  }

  const rejected = materialsRejected(sieveResidue, ash);
  db.seq = (db.seq || 1000) + 1;
  const batch = {
    id: "PB-" + db.seq,
    requestId: requestId || null,
    smokeBatch,
    vat,
    glueBatch,
    sieveResidue,
    ash,
    glueViscosity,
    status: rejected ? STATUS.RETURNED : STATUS.PENDING,
    viscosityChecks: [],
    release: null,
    history: [{
      at: now.toISOString(),
      event: rejected ? "退回筛料" : "创建配胶",
      note: rejected
        ? `筛余率${sieveResidue}%或灰分${ash}%超限，只能退回筛料，不得进入成型`
        : `绑定烟料批次${smokeBatch}、调胶缸${vat}、胶液批次${glueBatch}，进入待复核`
    }],
    createdAt: now.toISOString()
  };
  db.batches.unshift(batch);
  return result(201, summarize(batch), true);
}

// 粘度复核：两人各测一次，两次都在 25±2 秒且操作人不同才放行
export function addViscosityCheck(db, id, input, now = new Date()) {
  const batch = db.batches.find(b => b.id === id);
  if (!batch) return result(404, { error: "batch_not_found" });
  if (batch.status === STATUS.RETURNED) return result(409, { error: "batch_returned", message: "已退回筛料，不得进入成型复核" });
  if (batch.status === STATUS.MOLDABLE) return result(409, { error: "batch_already_released", message: "该批次已放行，无需再复核" });
  const operator = String(input.operator ?? "").trim();
  const seconds = Number(input.seconds);
  if (!operator) return result(400, { error: "missing_operator", message: "必须填写操作人" });
  if (!Number.isFinite(seconds) || seconds <= 0) return result(400, { error: "invalid_seconds", message: "粘度秒数须为大于0的数字" });

  const existing = batch.viscosityChecks.find(c => c.operator === operator);
  if (existing) {
    // 同一操作人重复提交相同结果：沿用首次；结果不同则拒绝（每人只测一次）
    if (existing.seconds === seconds) return result(200, { ...summarize(batch), deduplicated: true });
    return result(409, { error: "operator_already_checked", operator, message: `${operator}已测过，须由另一人复核` });
  }

  const check = { operator, seconds, inRange: isViscosityQualified(seconds), at: now.toISOString() };
  batch.viscosityChecks.push(check);
  batch.history.push({
    at: now.toISOString(),
    event: "粘度复核",
    note: `${operator}实测${seconds}秒，${check.inRange ? "在25±2秒内" : "超出25±2秒"}`
  });

  const qualified = batch.viscosityChecks.filter(c => c.inRange);
  if (qualified.length >= 2) {
    batch.status = STATUS.MOLDABLE;
    batch.release = { at: now.toISOString(), operators: qualified.slice(0, 2).map(c => c.operator) };
    batch.history.push({
      at: now.toISOString(),
      event: "放行",
      note: `${batch.release.operators.join("、")}两人复核均在25±2秒，放行进入成型`
    });
  }
  return result(201, summarize(batch), true);
}

// 调整烟料或胶液批次：旧放行立即失效并回到待复核，旧结论留档但不计入可成型列表
export function adjustBatch(db, id, input, now = new Date()) {
  const batch = db.batches.find(b => b.id === id);
  if (!batch) return result(404, { error: "batch_not_found" });
  if (batch.status === STATUS.RETURNED) return result(409, { error: "batch_returned", message: "已退回筛料，不得再调整" });
  const hasSmoke = input.smokeBatch !== undefined;
  const hasGlue = input.glueBatch !== undefined;
  if (!hasSmoke && !hasGlue) return result(400, { error: "nothing_to_adjust", message: "请提供新的烟料批次或胶液批次" });
  const nextSmoke = hasSmoke ? String(input.smokeBatch).trim() : batch.smokeBatch;
  const nextGlue = hasGlue ? String(input.glueBatch).trim() : batch.glueBatch;
  if (!nextSmoke || !nextGlue) return result(400, { error: "empty_batch_ref", message: "批次号不能为空" });
  if (nextSmoke === batch.smokeBatch && nextGlue === batch.glueBatch) {
    return result(200, { ...summarize(batch), unchanged: true });
  }

  const changedParts = [];
  if (nextSmoke !== batch.smokeBatch) changedParts.push("烟料批次");
  if (nextGlue !== batch.glueBatch) changedParts.push("胶液批次");
  if (batch.release || batch.viscosityChecks.length) {
    batch.history.push({
      at: now.toISOString(),
      event: "旧结论留档",
      note: `调整${changedParts.join("与")}，原「${batch.status}」结论失效，不再计入可成型列表`,
      archived: { status: batch.status, release: batch.release, viscosityChecks: batch.viscosityChecks }
    });
  }
  batch.smokeBatch = nextSmoke;
  batch.glueBatch = nextGlue;
  batch.viscosityChecks = [];
  batch.release = null;
  batch.status = STATUS.PENDING;
  batch.history.push({ at: now.toISOString(), event: "调整批次", note: `${changedParts.join("与")}已调整，回到待复核` });
  return result(200, summarize(batch), true);
}
