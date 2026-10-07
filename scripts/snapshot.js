// 快照脚本：对全部排放口 × 已有月份 × COD/氨氮，输出月均、月总量、超标结论。
// 用法：node scripts/snapshot.js <输出文件>
// 直接复用 server/monitor.js 的口径函数，改代码前后各跑一次即可对照。
const fs = require('fs');
const store = require('../server/store');
const monitor = require('../server/monitor');

const data = store.load();
const months = Array.from(new Set(data.readings.map((r) => store.monthOf(r.at)))).sort();
const metrics = ['COD', '氨氮'];

const out = [];
for (const outlet of data.outlets) {
  const plant = monitor.plantOf(data, outlet.plantId);
  for (const month of months) {
    for (const metric of metrics) {
      const has = monitor.readingsOf(data, { outletId: outlet.id, metric, month }).length > 0;
      if (!has) continue;
      const ex = monitor.exceedance(data, outlet.id, metric, month);
      out.push({
        outletId: outlet.id,
        outletCode: outlet.code,
        outletName: outlet.name,
        plantName: plant ? plant.name : '',
        month,
        metric,
        monthAverage: ex.monthAverage,
        monthTotalTons: monitor.monthTotal(data, outlet.id, metric, month),
        exceedDaysCount: ex.exceedDaysCount,
        exceedHours: ex.exceedHours,
        exceeded: ex.exceeded,
      });
    }
  }
}

const target = process.argv[2];
if (target) fs.writeFileSync(target, JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
