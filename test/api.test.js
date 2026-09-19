import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "glue-review-"));
  const server = await createApp({ dbPath: join(dir, "db.json"), seed: { seq: 1000, batches: [] } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    dir,
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections?.();
      await closed;
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function api(base, path, options = {}) {
  const res = await fetch(base + path, options.body
    ? { ...options, headers: { "Content-Type": "application/json" } }
    : options);
  return { status: res.status, data: await res.json() };
}

const validBatch = {
  smokeBatch: "黄山松烟-T01",
  vat: "调胶缸-T1",
  glueBatch: "明胶液-T01",
  sieveResidue: 1.5,
  ash: 0.4,
  glueViscosity: 25.0
};

test("提交配胶绑定三要素并登记指标，重复提交沿用首次结果", async () => {
  const { base, close } = await startServer();
  try {
    const created = await api(base, "/api/batches", {
      method: "POST",
      body: JSON.stringify({ ...validBatch, requestId: "req-1" })
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.status, "待复核");
    assert.equal(created.data.smokeBatch, "黄山松烟-T01");
    assert.equal(created.data.vat, "调胶缸-T1");
    assert.equal(created.data.glueBatch, "明胶液-T01");
    assert.equal(created.data.sieveResidue, 1.5);
    assert.equal(created.data.ash, 0.4);
    assert.equal(created.data.glueViscosity, 25.0);

    // 同一 requestId 重复提交：沿用首次结果，不新增记录
    const dup = await api(base, "/api/batches", {
      method: "POST",
      body: JSON.stringify({ ...validBatch, smokeBatch: "另一批烟料", requestId: "req-1" })
    });
    assert.equal(dup.status, 200);
    assert.equal(dup.data.id, created.data.id);
    assert.equal(dup.data.deduplicated, true);
    assert.equal(dup.data.smokeBatch, "黄山松烟-T01");

    const list = await api(base, "/api/batches");
    assert.equal(list.data.length, 1);
  } finally {
    await close();
  }
});

test("并发提交同一 requestId 只落库一次", async () => {
  const { base, close } = await startServer();
  try {
    const payload = JSON.stringify({ ...validBatch, requestId: "req-concurrent" });
    const [a, b] = await Promise.all([
      api(base, "/api/batches", { method: "POST", body: payload }),
      api(base, "/api/batches", { method: "POST", body: payload })
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 201]);
    assert.equal(a.data.id, b.data.id);
    const list = await api(base, "/api/batches");
    assert.equal(list.data.length, 1);
  } finally {
    await close();
  }
});

test("同一调胶缸未完成前再次提交返回409且不落库，完成后可再用", async () => {
  const { base, close } = await startServer();
  try {
    const first = await api(base, "/api/batches", {
      method: "POST",
      body: JSON.stringify({ ...validBatch, requestId: "req-a" })
    });
    assert.equal(first.status, 201);

    const conflict = await api(base, "/api/batches", {
      method: "POST",
      body: JSON.stringify({ ...validBatch, smokeBatch: "桐油烟-T02", requestId: "req-b" })
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.error, "vat_busy");
    assert.equal(conflict.data.activeBatch, first.data.id);

    // 不落库：列表仍只有一条
    let list = await api(base, "/api/batches");
    assert.equal(list.data.length, 1);

    // 放行后该缸可再次配胶
    await api(base, `/api/batches/${first.data.id}/checks`, { method: "POST", body: JSON.stringify({ operator: "甲", seconds: 24.5 }) });
    await api(base, `/api/batches/${first.data.id}/checks`, { method: "POST", body: JSON.stringify({ operator: "乙", seconds: 25.5 }) });
    const second = await api(base, "/api/batches", {
      method: "POST",
      body: JSON.stringify({ ...validBatch, smokeBatch: "桐油烟-T02", requestId: "req-c" })
    });
    assert.equal(second.status, 201);
    list = await api(base, "/api/batches");
    assert.equal(list.data.length, 2);
  } finally {
    await close();
  }
});

test("筛余率或灰分超限只能退回筛料，不得进入成型", async () => {
  const { base, close } = await startServer();
  try {
    const rejected = await api(base, "/api/batches", {
      method: "POST",
      body: JSON.stringify({ ...validBatch, sieveResidue: 3.1, requestId: "req-r1" })
    });
    assert.equal(rejected.status, 201);
    assert.equal(rejected.data.status, "退回筛料");

    const rejected2 = await api(base, "/api/batches", {
      method: "POST",
      body: JSON.stringify({ ...validBatch, vat: "调胶缸-T2", ash: 0.81, requestId: "req-r2" })
    });
    assert.equal(rejected2.data.status, "退回筛料");

    // 退回筛料的批次不能复核、不能调整
    const check = await api(base, `/api/batches/${rejected.data.id}/checks`, {
      method: "POST",
      body: JSON.stringify({ operator: "甲", seconds: 25 })
    });
    assert.equal(check.status, 409);
    const adjust = await api(base, `/api/batches/${rejected.data.id}`, {
      method: "PATCH",
      body: JSON.stringify({ smokeBatch: "新烟料" })
    });
    assert.equal(adjust.status, 409);

    // 边界值：恰好 3% / 0.8% 不算超限
    const edge = await api(base, "/api/batches", {
      method: "POST",
      body: JSON.stringify({ ...validBatch, vat: "调胶缸-T3", sieveResidue: 3, ash: 0.8, requestId: "req-r3" })
    });
    assert.equal(edge.data.status, "待复核");
  } finally {
    await close();
  }
});

test("两人各测一次且都在25±2秒才放行，操作人必须不同", async () => {
  const { base, close } = await startServer();
  try {
    const created = await api(base, "/api/batches", {
      method: "POST",
      body: JSON.stringify({ ...validBatch, requestId: "req-v1" })
    });
    const id = created.data.id;

    // 同一操作人不能测两次
    await api(base, `/api/batches/${id}/checks`, { method: "POST", body: JSON.stringify({ operator: "甲", seconds: 24 }) });
    const sameOp = await api(base, `/api/batches/${id}/checks`, { method: "POST", body: JSON.stringify({ operator: "甲", seconds: 26 }) });
    assert.equal(sameOp.status, 409);
    assert.equal(sameOp.data.error, "operator_already_checked");

    // 同一操作人重复提交相同结果：沿用首次
    const dupCheck = await api(base, `/api/batches/${id}/checks`, { method: "POST", body: JSON.stringify({ operator: "甲", seconds: 24 }) });
    assert.equal(dupCheck.status, 200);
    assert.equal(dupCheck.data.deduplicated, true);

    // 第二人超差：不放行
    const outOfRange = await api(base, `/api/batches/${id}/checks`, { method: "POST", body: JSON.stringify({ operator: "乙", seconds: 28 }) });
    assert.equal(outOfRange.status, 201);
    assert.equal(outOfRange.data.status, "待复核");

    // 第三人合格：与甲构成双人合格，放行
    const released = await api(base, `/api/batches/${id}/checks`, { method: "POST", body: JSON.stringify({ operator: "丙", seconds: 26.9 }) });
    assert.equal(released.data.status, "可成型");
    assert.deepEqual(released.data.release.operators, ["甲", "丙"]);

    // 已放行批次不能再复核
    const afterRelease = await api(base, `/api/batches/${id}/checks`, { method: "POST", body: JSON.stringify({ operator: "丁", seconds: 25 }) });
    assert.equal(afterRelease.status, 409);
  } finally {
    await close();
  }
});

test("调整烟料或胶液批次使旧放行失效并留档，不计入可成型列表", async () => {
  const { base, close } = await startServer();
  try {
    const created = await api(base, "/api/batches", {
      method: "POST",
      body: JSON.stringify({ ...validBatch, requestId: "req-adj" })
    });
    const id = created.data.id;
    await api(base, `/api/batches/${id}/checks`, { method: "POST", body: JSON.stringify({ operator: "甲", seconds: 25 }) });
    await api(base, `/api/batches/${id}/checks`, { method: "POST", body: JSON.stringify({ operator: "乙", seconds: 24 }) });

    let stats = await api(base, "/api/stats");
    assert.equal(stats.data["可成型"], 1);

    const adjusted = await api(base, `/api/batches/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ smokeBatch: "桐油烟-T09" })
    });
    assert.equal(adjusted.status, 200);
    assert.equal(adjusted.data.status, "待复核");
    assert.equal(adjusted.data.release, null);
    assert.equal(adjusted.data.viscosityChecks.length, 0);
    assert.equal(adjusted.data.smokeBatch, "桐油烟-T09");

    // 旧结论留档
    const archived = adjusted.data.history.find(h => h.event === "旧结论留档");
    assert.ok(archived);
    assert.equal(archived.archived.status, "可成型");
    assert.equal(archived.archived.viscosityChecks.length, 2);

    // 不再计入可成型列表
    stats = await api(base, "/api/stats");
    assert.equal(stats.data["可成型"], 0);
    assert.equal(stats.data["待复核"], 1);
    const moldable = (await api(base, "/api/batches")).data.filter(b => b.status === "可成型");
    assert.equal(moldable.length, 0);

    // 调整后可重新复核放行
    await api(base, `/api/batches/${id}/checks`, { method: "POST", body: JSON.stringify({ operator: "甲", seconds: 25 }) });
    const reReleased = await api(base, `/api/batches/${id}/checks`, { method: "POST", body: JSON.stringify({ operator: "乙", seconds: 25 }) });
    assert.equal(reReleased.data.status, "可成型");
  } finally {
    await close();
  }
});

test("列表、统计与刷新（重启）后一致", async () => {
  const { base, dir, close } = await startServer();
  const dbPath = join(dir, "db.json");
  let server2;
  try {
    await api(base, "/api/batches", { method: "POST", body: JSON.stringify({ ...validBatch, requestId: "req-p1" }) });
    await api(base, "/api/batches", { method: "POST", body: JSON.stringify({ ...validBatch, vat: "调胶缸-T2", sieveResidue: 4, requestId: "req-p2" }) });
    const statsBefore = (await api(base, "/api/stats")).data;
    const listBefore = (await api(base, "/api/batches")).data;
    assert.equal(statsBefore["待复核"], 1);
    assert.equal(statsBefore["退回筛料"], 1);

    // 用同一数据文件重启，模拟刷新后的持久化一致性
    server2 = await createApp({ dbPath, seed: { seq: 1000, batches: [] } });
    await new Promise(resolve => server2.listen(0, "127.0.0.1", resolve));
    const base2 = `http://127.0.0.1:${server2.address().port}`;
    const statsAfter = (await api(base2, "/api/stats")).data;
    const listAfter = (await api(base2, "/api/batches")).data;
    assert.deepEqual(statsAfter, statsBefore);
    assert.deepEqual(listAfter, listBefore);
  } finally {
    if (server2) {
      const closed2 = new Promise(resolve => server2.close(resolve));
      server2.closeAllConnections?.();
      await closed2;
    }
    await close();
  }
});
