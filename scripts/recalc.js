// 全量重算：遍历所有排放口 × 已有数据月份 × COD/氨氮，
// 调用线上同一套 monitor 取数/核算口径（effectiveConcentration 集中折算），
// 输出每个组合的月均、月总量、超标天数/小时/判定，供改动前后对照。
// 用法：node scripts/recalc.js            输出 JSON（默认数据文件）
//      node scripts/recalc.js --table    输出表格
const fs = require('fs');
const path = require('path');
const monitor = require(path.join(__dirname, '..', 'server', 'monitor'));
const store = require(path.join(__dirname, '..', 'server', 'store'));

function gather() {
  const data = store.load();
  const months = Array.from(new Set(data.readings.map((r) => store.monthOf(r.at)))).sort();
  const rows = [];
  for (const outlet of data.outlets) {
    for (const month of months) {
      for (const metric of ['COD', '氨氮']) {
        const has = data.readings.some((r) => r.outletId === outlet.id && r.metric === metric && store.monthOf(r.at) === month);
        if (!has) continue;
        const sum = monitor.outletSummary(data, outlet.id, month);
        const rr = sum.rows.find((x) => x.metric === metric);
        const ex = monitor.exceedance(data, outlet.id, metric, month);
        // 该排放口该指标该月有效计入的小时里，缺同时刻氧含量读数的小时数
        const conc = monitor.readingsOf(data, { outletId: outlet.id, metric, month });
        const devOf = {};
        const counted = conc.filter((r) => monitor.isCounted(r, monitor.deviceOf(data, r.deviceId), data.settings));
        let missingOxygen = 0;
        for (const r of counted) {
          if (monitor.oxygenAt(data, r) === null) missingOxygen += 1;
        }
        rows.push({
          outlet: outlet.code,
          outletName: outlet.name,
          plant: (monitor.plantOf(data, outlet.plantId) || {}).code || '',
          status: outlet.status,
          month,
          metric,
          monthAverage: rr.monthAverage,
          monthTotalTons: rr.monthTotalTons,
          exceedDaysCount: rr.exceedDaysCount,
          exceedHours: rr.exceedHours,
          exceeded: rr.exceeded,
          hourlyExceed: ex.hourlyExceed,
          missingOxygenHours: missingOxygen,
        });
      }
    }
  }
  return { baseline: Number(data.settings.oxygenBaseline), months, rows };
}

if (require.main === module) {
  const result = gather();
  if (process.argv.includes('--table')) {
    console.log('基准氧含量 =', result.baseline);
    console.log('排放口  月份      指标  月均      月总量(吨)  超标天  超标小时  结论   缺氧/总计入小时');
    for (const r of result.rows) {
      console.log([
        r.outlet, r.month, r.metric,
        String(r.monthAverage).padEnd(8),
        String(r.monthTotalTons).padEnd(10),
        String(r.exceedDaysCount).padStart(5),
        String(r.exceedHours).padStart(7),
        (r.exceeded ? '超标' : '达标').padEnd(4),
        r.missingOxygenHours,
      ].join('  '));
    }
  } else {
    process.stdout.write(JSON.stringify(result, null, 2));
  }
}

module.exports = { gather };
