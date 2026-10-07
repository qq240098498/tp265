// 监测数据口径都集中在这里：有效读数、折算、日均、总量、超标、许可
//
// 取数纪律：浓度类指标（COD、氨氮）一入统计就先折算成「折算后浓度」，
// 下游的日平均、月平均、月总量、超标判定、报表全部只吃折算后的值，
// 不再碰实测值。折算口径：
//   折算浓度 = 实测浓度 × (21 − 基准氧含量) / (21 − 实测氧含量)
// 同一时刻没有氧含量读数（或氧读数无效）时按基准氧处理，等价于不折算。
// 基准氧含量取 settings.oxygenBaseline，改设置后所有历史结论读时即重算。
const store = require('./store');

const CONCENTRATION_METRICS = ['COD', '氨氮'];

function plantOf(data, id) {
  return data.plants.find((p) => p.id === id) || null;
}
function outletOf(data, id) {
  return data.outlets.find((o) => o.id === id) || null;
}
function deviceOf(data, id) {
  return data.devices.find((d) => d.id === id) || null;
}

function readingsOf(data, query) {
  const q = query || {};
  let rows = data.readings.slice();
  if (q.outletId) rows = rows.filter((r) => r.outletId === q.outletId);
  if (q.deviceId) rows = rows.filter((r) => r.deviceId === q.deviceId);
  if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
  if (q.day) rows = rows.filter((r) => store.dayOf(r.at) === q.day);
  if (q.month) rows = rows.filter((r) => store.monthOf(r.at) === q.month);
  return rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// 口径：折算浓度 = 实测浓度 × (21 − 基准氧) / (21 − 实测氧含量)
// oxygen 为 null/缺失/非数字时按基准氧代入（系数为 1，等价于不折算）。
function effectiveConcentration(reading, settings, oxygen) {
  const value = Number(reading && reading.value);
  if (!Number.isFinite(value)) return 0;
  const baselineSetting = Number(settings && settings.oxygenBaseline);
  const baseline = Number.isFinite(baselineSetting) ? baselineSetting : 8;
  let o2 = Number(oxygen);
  if (oxygen === null || oxygen === undefined || !Number.isFinite(o2)) o2 = baseline;
  const denom = 21 - o2;
  // 21% 及以上的氧含量在式子里没有物理意义，退化为不折算，避免分母为 0/负把数字放大
  if (!Number.isFinite(denom) || denom <= 0) return value;
  return value * (21 - baseline) / denom;
}

// 同排放口、同时刻的氧含量读数；只认「有效 + 设备正常」的读数，否则视为缺失（按基准氧）
function oxygenAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '氧含量' && r.at === reading.at);
  if (!row || row.flag !== '有效') return null;
  const device = deviceOf(data, row.deviceId);
  if (device && device.status !== '正常') return null;
  const v = Number(row.value);
  return Number.isFinite(v) ? v : null;
}

// 同排放口、同时刻的流量读数；无效/设备异常按 0，负值按 0
function flowAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '流量' && r.at === reading.at);
  if (!row || row.flag !== '有效') return 0;
  const device = deviceOf(data, row.deviceId);
  if (device && device.status !== '正常') return 0;
  const v = Number(row.value);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// 口径第 1 条：标记有效、设备正常、数值在量程内，三条都满足才算有效小时值。
// 停产/停用（口径第 8 条）在 hourlyRows 里结合 data 另行判定。
function isCounted(reading, device, settings) {
  if (!reading || reading.flag !== '有效') return false;
  if (!device || device.status !== '正常') return false;
  const v = Number(reading.value);
  if (!Number.isFinite(v)) return false;
  const min = Number(settings.rangeMin);
  const max = Number(settings.rangeMax);
  if (v < (Number.isFinite(min) ? min : 0) || v > (Number.isFinite(max) ? max : 500)) return false;
  return true;
}

function countReasons(reading, device, settings) {
  const reasons = [];
  if (!reading || reading.flag !== '有效') reasons.push('数据标记为' + (reading ? reading.flag : '空'));
  if (!device) reasons.push('监测设备不存在');
  else if (device.status !== '正常') reasons.push('设备处于' + device.status);
  const v = Number(reading && reading.value);
  const min = Number(settings.rangeMin);
  const max = Number(settings.rangeMax);
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) ? max : 500;
  if (!Number.isFinite(v)) reasons.push('数值不是有效数字');
  else if (v < lo || v > hi) reasons.push('数值 ' + v + ' 超出量程（' + lo + '~' + hi + '）');
  return reasons;
}

function isStopped(data, reading) {
  const outlet = outletOf(data, reading.outletId);
  const plant = outlet ? plantOf(data, outlet.plantId) : null;
  return !!(outlet && plant && (outlet.status === '停用' || plant.status === '停产'));
}

// 同一时刻多条读数时选一条代表：有效计入的优先，其次自动优先于补录，再按 id 排前。
function pickRepresentative(items) {
  return items.slice().sort((a, b) => {
    if (a.baseCounted !== b.baseCounted) return a.baseCounted ? -1 : 1;
    const rank = (s) => (s === '自动' ? 0 : 1);
    if (rank(a.reading.source) !== rank(b.reading.source)) return rank(a.reading.source) - rank(b.reading.source);
    return a.reading.id < b.reading.id ? -1 : 1;
  })[0];
}

// 取数层核心：某天某排放口某浓度指标，按「时刻」配对后逐小时给出折算浓度、氧含量与流量。
// 每小时只留一条代表读数（重复时刻不重复计），浓度在这一层已折算完。
function dayHourRows(data, outletId, metric, day) {
  const settings = data.settings;
  const outlet = outletOf(data, outletId);
  const plant = outlet ? plantOf(data, outlet.plantId) : null;
  const raw = readingsOf(data, { outletId, metric, day });
  const byAt = new Map();
  for (const reading of raw) {
    const device = deviceOf(data, reading.deviceId);
    const reasons = countReasons(reading, device, settings);
    if (isStopped(data, reading)) {
      reasons.push(plant && plant.status === '停产' ? '排污单位停产' : '排放口停用');
    }
    const baseCounted = reasons.length === 0;
    const bucket = byAt.get(reading.at) || { at: reading.at, items: [] };
    bucket.items.push({ reading, device, baseCounted, reasons });
    byAt.set(reading.at, bucket);
  }
  const hours = [];
  for (const bucket of byAt.values()) {
    const rep = pickRepresentative(bucket.items);
    const reading = rep.reading;
    const oxygen = oxygenAt(data, reading);
    const flow = flowAt(data, reading);
    const dropped = bucket.items.length - 1;
    const reasons = rep.reasons.slice();
    if (dropped > 0) reasons.push('同一时刻另有 ' + dropped + ' 条读数未采用');
    hours.push({
      id: reading.id,
      at: reading.at,
      hour: Number(String(reading.at).slice(11, 13)),
      value: Number(reading.value),
      source: reading.source,
      flag: reading.flag,
      deviceCode: rep.device ? rep.device.code : '',
      deviceStatus: rep.device ? rep.device.status : '',
      oxygen,
      oxygenMissing: oxygen === null,
      flow,
      counted: rep.baseCounted,
      reasons,
      concentration: store.round(effectiveConcentration(reading, settings, oxygen), 4),
      droppedDuplicates: dropped,
    });
  }
  return hours.sort((a, b) => (a.at < b.at ? -1 : 1));
}

// 一天的统计：先套用日级别规则（有效小时 ≥18、补录小时 ≤ 上限），再做流量加权日均。
function dailyStats(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = dayHourRows(data, outletId, metric, day);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const minHours = Number(settings.minDailyHours || 18);
  const maxImpute = Number(settings.maxImputeHoursPerDay || 6);
  const baseCounted = rows.filter((r) => r.counted);
  const imputedHours = baseCounted.filter((r) => r.source === '补录').length;

  const dayReasons = [];
  if (baseCounted.length < minHours) dayReasons.push('有效小时 ' + baseCounted.length + ' 不足 ' + minHours);
  if (imputedHours > maxImpute) dayReasons.push('补录小时 ' + imputedHours + ' 超过单日上限 ' + maxImpute);
  const valid = dayReasons.length === 0 && baseCounted.length > 0;
  if (!valid && baseCounted.length > 0) rows.forEach((r) => { if (r.counted) r.reasons.push('当日不计入：' + dayReasons.join('；')); });

  // 参与核算的小时 = 自身有效 且 当日有效（补录超限/有效小时不足时整日不进平均与总量）
  const used = valid ? baseCounted : [];
  let average = 0;
  if (used.length) {
    // 口径：按小时流量加权；该排放口没有流量数据时退化为算术平均（总量仍为 0）
    const flowSum = used.reduce((acc, r) => acc + r.flow, 0);
    if (flowSum > 0) {
      average = used.reduce((acc, r) => acc + r.concentration * r.flow, 0) / flowSum;
    } else {
      average = used.reduce((acc, r) => acc + r.concentration, 0) / used.length;
    }
  }
  const flowTotal = baseCounted.reduce((acc, r) => acc + r.flow, 0);
  return {
    day,
    outletId,
    metric,
    rows,
    countedHours: baseCounted.length,
    imputedHours,
    average: store.round(average, 2),
    valid,
    invalidReason: valid ? '' : dayReasons.join('；'),
    limit,
    exceed: valid && average > limit,
    flowTotal: store.round(flowTotal, 1),
  };
}

function dailySeries(data, outletId, metric, month) {
  const days = store.daysInMonth(month);
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    const day = month + '-' + String(d).padStart(2, '0');
    if (!readingsOf(data, { outletId, metric, day }).length) continue;
    out.push(dailyStats(data, outletId, metric, day));
  }
  return out;
}

// 月均值：只在「有效天」之间平均，分母是有效天数（不是当月天数）
function monthAverage(data, outletId, metric, month) {
  const series = dailySeries(data, outletId, metric, month).filter((s) => s.valid);
  if (!series.length) return 0;
  const sum = series.reduce((acc, s) => acc + s.average, 0);
  return store.round(sum / series.length, 2);
}

// 月总量（吨）：逐小时「同一时刻」的折算浓度 × 流量配对累加；日无效/小时无效都不进总量
function monthTotal(data, outletId, metric, month) {
  const settings = data.settings;
  const series = dailySeries(data, outletId, metric, month).filter((s) => s.valid);
  let mg = 0; // 毫克：折算浓度 mg/L × 流量 m³/h × 1000 L/m³
  for (const s of series) {
    for (const r of s.rows) {
      if (!r.counted) continue;
      mg += r.concentration * r.flow * 1000;
    }
  }
  return store.round(mg / Number(settings.tonsDivisor), 4);
}

// 季度总量：季度内各月逐小时累加，不做任何按天外推
function quarterTotal(data, outletId, metric, quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  const months = [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3]
    .map((m) => y + '-' + String(m).padStart(2, '0'));
  let total = 0;
  for (const m of months) {
    if (dailySeries(data, outletId, metric, m).length) total += monthTotal(data, outletId, metric, m);
  }
  return store.round(total, 4);
}

// 季度许可量：年许可量 × 该季度实际天数 / 全年天数
function quarterPermitTons(data, metric, quarter) {
  const settings = data.settings;
  const annual = metric === '氨氮' ? Number(settings.annualPermitAmmoniaTons) : Number(settings.annualPermitCodTons);
  const year = Number(String(quarter).slice(0, 4));
  const yearDays = ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) ? 366 : 365;
  return store.round(annual * store.daysInQuarter(quarter) / yearDays, 4);
}

function inPermitYear(at, permitYearStart) {
  const start = String(permitYearStart || '2026-01-01').slice(0, 10);
  const t = String(at).slice(0, 10);
  if (t < start) return false;
  const [y, m, d] = start.split('-').map(Number);
  const end = Date.UTC(y + 1, m - 1, d);
  return Date.UTC(t.slice(0, 4), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10))) < end;
}

// 年累计：按各单位许可年（许可年起始日）逐小时累加，跨自然年不带入其他许可年的数据
function accumulatedTons(data, metric) {
  let total = 0;
  for (const outlet of data.outlets) {
    const plant = plantOf(data, outlet.plantId);
    const start = plant ? plant.permitYearStart : data.settings.permitYearStart;
    const months = Array.from(new Set(
      data.readings
        .filter((r) => r.outletId === outlet.id && r.metric === metric && inPermitYear(r.at, start))
        .map((r) => store.monthOf(r.at))
    ));
    for (const month of months) total += monthTotal(data, outlet.id, metric, month);
  }
  return store.round(total, 4);
}

// 超标判定：折算后的日均超限值，或者折算后的小时值超限值达到规定次数；两条分别给出
function exceedance(data, outletId, metric, month) {
  const settings = data.settings;
  const series = dailySeries(data, outletId, metric, month);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const exceedDays = series.filter((s) => s.exceed).map((s) => s.day);
  let exceedHours = 0;
  for (const s of series) {
    if (!s.valid) continue;
    for (const row of s.rows) if (row.counted && row.concentration > limit) exceedHours += 1;
  }
  const hourlyExceed = exceedHours >= Number(settings.hourlyExceedCountLimit);
  return {
    month,
    outletId,
    metric,
    limit,
    exceedDays,
    exceedDaysCount: exceedDays.length,
    exceedHours,
    hourlyExceed,
    exceeded: exceedDays.length > 0 || hourlyExceed,
    monthAverage: monthAverage(data, outletId, metric, month),
  };
}

function outletsOf(data, plantId) {
  return data.outlets.filter((o) => o.plantId === plantId);
}

// 排放口汇总：逐指标给出月均、月总量、超标情况（全部基于折算后浓度）
function outletSummary(data, outletId, month) {
  const outlet = outletOf(data, outletId);
  const settings = data.settings;
  const metrics = CONCENTRATION_METRICS;
  const rows = metrics.map((metric) => {
    const ex = exceedance(data, outletId, metric, month);
    return {
      metric,
      monthAverage: ex.monthAverage,
      monthTotalTons: monthTotal(data, outletId, metric, month),
      exceedDaysCount: ex.exceedDaysCount,
      exceedHours: ex.exceedHours,
      hourlyExceed: ex.hourlyExceed,
      exceeded: ex.exceeded,
      limit: ex.limit,
    };
  });
  const devices = data.devices.filter((d) => d.outletId === outletId).map((d) => Object.assign({}, d, {
    readingCount: data.readings.filter((r) => r.deviceId === d.id).length,
  }));
  return {
    outlet,
    plant: outlet ? plantOf(data, outlet.plantId) : null,
    month,
    rows,
    devices,
    quarterTotalCod: quarterTotal(data, outletId, 'COD', store.quarterOf(month)),
    permitCodTons: quarterPermitTons(data, 'COD', store.quarterOf(month)),
    annualPermitCodTons: Number(settings.annualPermitCodTons),
    accumulatedCodTons: accumulatedTons(data, 'COD'),
    accumulatedAmmoniaTons: accumulatedTons(data, '氨氮'),
    oxygenBaseline: Number(settings.oxygenBaseline),
    settings,
  };
}

module.exports = {
  plantOf, outletOf, deviceOf,
  readingsOf, isCounted, effectiveConcentration, oxygenAt, flowAt,
  dayHourRows, dailyStats, dailySeries, monthAverage, monthTotal,
  quarterTotal, quarterPermitTons, accumulatedTons,
  exceedance, outletsOf, outletSummary,
  CONCENTRATION_METRICS,
};
