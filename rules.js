// 配胶规则模块：绑定校验、调胶缸占用、质量门限、双人双测放行、
// 批次调整失效留档、并发幂等，以及列表/统计的统一口径。
export const SIEVE_LIMIT = 3; // 筛余率上限 %
export const ASH_LIMIT = 0.8; // 灰分上限 %
export const VISCOSITY_MID = 25; // 粘度目标 秒
export const VISCOSITY_TOLERANCE = 2; // 25±2 秒

export const STATUS = {
  pending: "待复核",
  formable: "可成型",
  rejected: "退回筛料",
  failedReview: "复核未过"
};
export const STATUSES = [STATUS.pending, STATUS.formable, STATUS.rejected, STATUS.failedReview];
const ACTIVE_STATUSES = [STATUS.pending, STATUS.failedReview]; // 未完成、仍占用调胶缸的状态

export class RuleError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function now() {
  return new Date().toISOString();
}
function newId(seq) {
  return "PM-" + String(seq).padStart(3, "0");
}
function qualityFailed(b) {
  return b.sieveResidue > SIEVE_LIMIT || b.ash > ASH_LIMIT;
}
function inViscosityRange(v) {
  return v >= VISCOSITY_MID - VISCOSITY_TOLERANCE && v <= VISCOSITY_MID + VISCOSITY_TOLERANCE;
}
function fingerprint(input) {
  return [input.smokeBatch, input.vat, input.glueBatch, input.sieveResidue, input.ash, input.glueViscosity].join("|");
}
function isActive(b) {
  return ACTIVE_STATUSES.includes(b.status);
}

export function createGlueService(store) {
  // 重复或并发提交沿用首次结果：占用中的同指纹批次直接幂等返回。
  function findDuplicate(db, input) {
    const fp = fingerprint(input);
    return db.batches.find(b => isActive(b) && b.vat === input.vat && fingerprint(b) === fp);
  }
  function findVatOccupant(db, vat, exceptId) {
    return db.batches.find(b => isActive(b) && b.vat === vat && b.id !== exceptId);
  }
  function parseMetric(input, key, label, max) {
    const raw = input[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      throw new RuleError(400, "missing_field", label + "必填");
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || (max !== undefined && value > max * 5)) {
      throw new RuleError(400, "invalid_field", label + "数值不合法");
    }
    return value;
  }
  function parseBindings(input) {
    const out = {};
    for (const [key, label] of [["smokeBatch", "烟料批次"], ["vat", "调胶缸"], ["glueBatch", "胶液批次"]]) {
      const v = String(input[key] ?? "").trim();
      if (!v) throw new RuleError(400, "missing_field", label + "必填，每次配胶须绑定一种烟料批次、一个调胶缸和胶液批次");
      out[key] = v;
    }
    out.sieveResidue = parseMetric(input, "sieveResidue", "筛余率(%)", SIEVE_LIMIT);
    out.ash = parseMetric(input, "ash", "灰分(%)", ASH_LIMIT);
    out.glueViscosity = parseMetric(input, "glueViscosity", "胶液粘度(秒)");
    return out;
  }

  return {
    async create(input) {
      return store.mutate(db => {
        const data = parseBindings(input);
        const dup = findDuplicate(db, data);
        if (dup) return { batch: dup, idempotent: true }; // 重复/并发沿用首次结果
        if (findVatOccupant(db, data.vat)) {
          // 同一缸未完成前再次提交：409 且不落库
          throw new RuleError(409, "vat_busy", "调胶缸 " + data.vat + " 有未完成配胶，禁止再次提交");
        }
        const seq = db.batches.reduce((m, b) => Math.max(m, parseInt(String(b.id).split("-")[1], 10) || 0), 0) + 1;
        const ts = now();
        const batch = {
          id: newId(seq),
          smokeBatch: data.smokeBatch,
          vat: data.vat,
          glueBatch: data.glueBatch,
          sieveResidue: data.sieveResidue,
          ash: data.ash,
          glueViscosity: data.glueViscosity,
          status: STATUS.pending,
          revision: 1,
          createdAt: ts,
          updatedAt: ts,
          measurements: [],
          history: [],
          logs: [{ at: ts, step: "配胶登记", note: "绑定烟料 " + data.smokeBatch + " / 调胶缸 " + data.vat + " / 胶液 " + data.glueBatch }]
        };
        if (qualityFailed(batch)) {
          // 筛余率>3% 或灰分>0.8%：只能退回筛料，不得进入成型
          batch.status = STATUS.rejected;
          batch.logs.push({
            at: ts,
            step: "质量门限",
            note:
              (batch.sieveResidue > SIEVE_LIMIT ? "筛余率 " + batch.sieveResidue + "% 超过 " + SIEVE_LIMIT + "%；" : "") +
              (batch.ash > ASH_LIMIT ? "灰分 " + batch.ash + "% 超过 " + ASH_LIMIT + "%；" : "") +
              "退回筛料，不得进入成型"
          });
        }
        db.batches.unshift(batch);
        return { batch, idempotent: false };
      });
    },

    async addMeasurement(id, input) {
      return store.mutate(db => {
        const batch = db.batches.find(b => b.id === id);
        if (!batch) throw new RuleError(404, "not_found", "配胶记录不存在");
        if (batch.status === STATUS.rejected) throw new RuleError(409, "rejected", "该批已退回筛料，不得测量放行");
        if (batch.status === STATUS.formable) throw new RuleError(409, "released", "该批已放行，无需再次测量");
        if (batch.status === STATUS.failedReview) throw new RuleError(409, "review_failed", "复核未过，请申请重新复核或调整批次");
        if (batch.measurements.length >= 2) throw new RuleError(409, "measured_twice", "本版配胶已完成两次测量");
        const operator = String(input.operator ?? "").trim();
        if (!operator) throw new RuleError(400, "missing_field", "操作人必填");
        const viscosity = Number(input.viscosity);
        if (!Number.isFinite(viscosity) || viscosity <= 0) throw new RuleError(400, "invalid_field", "粘度数值不合法");
        if (batch.measurements.some(m => m.operator === operator)) {
          throw new RuleError(409, "same_operator", "两次测量必须由不同操作人完成");
        }
        const ts = now();
        batch.measurements.push({ at: ts, operator, viscosity });
        batch.updatedAt = ts;
        if (batch.measurements.length === 1) {
          batch.logs.push({ at: ts, step: "粘度" + (batch.revision > 1 ? "复测" : "首测"), note: operator + " " + viscosity + "秒，等待第二位操作人复测" });
        } else {
          // 两次都在 25±2 秒且操作人不同才可放行
          const pass = batch.measurements.every(m => inViscosityRange(m.viscosity));
          if (pass) {
            batch.status = STATUS.formable;
            batch.logs.push({ at: ts, step: "粘度复测", note: operator + " " + viscosity + "秒，双人双测通过，放行成型" });
          } else {
            batch.status = STATUS.failedReview;
            batch.logs.push({ at: ts, step: "粘度复测", note: operator + " " + viscosity + "秒，不在 25±2 秒，复核未过" });
          }
        }
        return batch;
      });
    },

    async recheck(id) {
      return store.mutate(db => {
        const batch = db.batches.find(b => b.id === id);
        if (!batch) throw new RuleError(404, "not_found", "配胶记录不存在");
        if (batch.status !== STATUS.failedReview) throw new RuleError(409, "not_review_failed", "仅复核未过的批次可以申请重新复核");
        const ts = now();
        batch.history.push({
          reason: "重新复核",
          at: ts,
          conclusion: { status: batch.status, measurements: batch.measurements.map(m => ({ ...m })) },
          note: "未过结论留档，不计入可成型列表"
        });
        batch.status = STATUS.pending;
        batch.measurements = [];
        batch.updatedAt = ts;
        batch.logs.push({ at: ts, step: "重新复核", note: "未过结论已留档，回到待复核，重新双人双测" });
        return batch;
      });
    },

    async adjust(id, patch) {
      return store.mutate(db => {
        const batch = db.batches.find(b => b.id === id);
        if (!batch) throw new RuleError(404, "not_found", "配胶记录不存在");
        if (patch.vat !== undefined && String(patch.vat).trim() !== "" && String(patch.vat).trim() !== batch.vat) {
          throw new RuleError(400, "vat_locked", "调胶缸在配胶周期内不可更换");
        }
        const candidate = { ...batch };
        for (const key of ["sieveResidue", "ash", "glueViscosity"]) {
          if (patch[key] !== undefined) {
            const value = Number(patch[key]);
            if (!Number.isFinite(value) || value < 0) throw new RuleError(400, "invalid_field", key + "数值不合法");
            candidate[key] = value;
          }
        }
        for (const [key, label] of [["smokeBatch", "烟料批次"], ["glueBatch", "胶液批次"]]) {
          if (patch[key] !== undefined) {
            const v = String(patch[key]).trim();
            if (!v) throw new RuleError(400, "invalid_field", label + "不能为空");
            candidate[key] = v;
          }
        }
        const bindingChanged = candidate.smokeBatch !== batch.smokeBatch || candidate.glueBatch !== batch.glueBatch;
        if (!bindingChanged && candidate.sieveResidue === batch.sieveResidue && candidate.ash === batch.ash && candidate.glueViscosity === batch.glueViscosity) {
          throw new RuleError(400, "no_change", "没有可调整的内容");
        }
        const ts = now();
        if (!bindingChanged) {
          // 仅订正登记指标：批次绑定与放行结论都不变
          batch.sieveResidue = candidate.sieveResidue;
          batch.ash = candidate.ash;
          batch.glueViscosity = candidate.glueViscosity;
          batch.updatedAt = ts;
          batch.logs.push({ at: ts, step: "指标订正", note: "筛余率 " + batch.sieveResidue + "%，灰分 " + batch.ash + "%，胶液粘度 " + batch.glueViscosity + "秒" });
          return batch;
        }
        if (findVatOccupant(db, batch.vat, batch.id)) {
          throw new RuleError(409, "vat_busy", "调胶缸 " + batch.vat + " 另有未完成配胶，无法在此缸上调整");
        }
        // 调整烟料或胶液批次：旧放行立即失效并回到待复核，旧结论留档但不计入可成型列表
        batch.history.push({
          reason: "批次调整",
          at: ts,
          from: { smokeBatch: batch.smokeBatch, glueBatch: batch.glueBatch },
          to: { smokeBatch: candidate.smokeBatch, glueBatch: candidate.glueBatch },
          conclusion: { status: batch.status, measurements: batch.measurements.map(m => ({ ...m })) },
          note: "调整烟料或胶液批次，旧结论立即失效，留档但不计入可成型列表"
        });
        batch.smokeBatch = candidate.smokeBatch;
        batch.glueBatch = candidate.glueBatch;
        batch.sieveResidue = candidate.sieveResidue;
        batch.ash = candidate.ash;
        batch.glueViscosity = candidate.glueViscosity;
        batch.measurements = [];
        batch.revision += 1;
        batch.updatedAt = ts;
        if (qualityFailed(batch)) {
          batch.status = STATUS.rejected;
          batch.logs.push({
            at: ts,
            step: "批次调整",
            note:
              "烟料/胶液批次已调整并回到待复核；" +
              (batch.sieveResidue > SIEVE_LIMIT ? "筛余率 " + batch.sieveResidue + "% 超 " + SIEVE_LIMIT + "%；" : "") +
              (batch.ash > ASH_LIMIT ? "灰分 " + batch.ash + "% 超 " + ASH_LIMIT + "%；" : "") +
              "退回筛料，不得进入成型"
          });
        } else {
          batch.status = STATUS.pending;
          batch.logs.push({ at: ts, step: "批次调整", note: "烟料/胶液批次调整完成，旧放行失效，回到待复核重新双人双测" });
        }
        return batch;
      });
    },

    async list() {
      const db = await store.read();
      return db.batches.map(view);
    },

    async stats() {
      const db = await store.read();
      return summarize(db.batches);
    }
  };
}

// 列表与统计共用同一份数据与同一套口径，刷新后保持一致。
export function view(batch) {
  return {
    ...batch,
    formable: batch.status === STATUS.formable,
    measurementCount: batch.measurements.length,
    archiveCount: batch.history.length
  };
}
export function summarize(batches) {
  const stats = Object.fromEntries(STATUSES.map(s => [s, 0])); // 「可成型」状态即放行可成型列表
  for (const b of batches) {
    if (stats[b.status] !== undefined) stats[b.status] += 1;
  }
  stats.total = batches.length;
  return stats;
}
