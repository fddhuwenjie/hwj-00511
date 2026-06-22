const fs = require('fs');
const path = require('path');
const os = require('os');
const RuleEngine = require('./lib/ruleEngine');
const CSVReader = require('./lib/csvReader');
const { QualityChecker } = require('./lib/qualityChecker');
const DataCleaner = require('./lib/dataCleaner');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + message);
  } else {
    failed++;
    console.log('  ✗ ' + message);
  }
}

function assertEq(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log('  ✓ ' + message);
  } else {
    failed++;
    console.log('  ✗ ' + message);
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'csvclean-test-'));
}

(async function runTests() {
  console.log('\n========================================');
  console.log('  CSVClean 单元测试');
  console.log('========================================\n');

  // ================================================================
  // Test 1: 统一日期解析 parseDateToMs
  // ================================================================
  console.log('Test 1: RuleEngine.parseDateToMs 统一日期解析');

  const iso1 = RuleEngine.parseDateToMs('2023-06-15');
  assert(iso1 !== null && !isNaN(iso1), 'ISO格式 YYYY-MM-DD 解析成功');
  assertEq(new Date(iso1).getFullYear(), 2023, 'ISO格式年份正确');
  assertEq(new Date(iso1).getMonth() + 1, 6, 'ISO格式月份正确');
  assertEq(new Date(iso1).getDate(), 15, 'ISO格式日期正确');

  const slash = RuleEngine.parseDateToMs('2023/06/16');
  assert(slash !== null, '斜杠格式 YYYY/MM/DD 解析成功');

  const dot = RuleEngine.parseDateToMs('2023.06.17');
  assert(dot !== null, '点号格式 YYYY.MM.DD 解析成功');

  const cn1 = RuleEngine.parseDateToMs('2023年6月18日');
  assert(cn1 !== null, '中文日期格式解析成功');
  assertEq(new Date(cn1).getFullYear(), 2023, '中文日期年份正确');
  assertEq(new Date(cn1).getMonth() + 1, 6, '中文日期月份正确');
  assertEq(new Date(cn1).getDate(), 18, '中文日期日份正确');

  const cn2 = RuleEngine.parseDateToMs('2023年12月4日');
  assert(cn2 !== null, '中文日期个位数月份日期解析成功');

  const ts10 = RuleEngine.parseDateToMs('1682995200');
  assert(ts10 !== null, '10位Unix时间戳解析成功');

  const ts13 = RuleEngine.parseDateToMs('1687267200000');
  assert(ts13 !== null, '13位毫秒时间戳解析成功');

  const dmy = RuleEngine.parseDateToMs('15-06-2023');
  assert(dmy !== null, 'DD-MM-YYYY 格式解析成功');

  const isoDt = RuleEngine.parseDateToMs('2023-06-15 14:30:00');
  assert(isoDt !== null, 'ISO带时间解析成功');

  const bad = RuleEngine.parseDateToMs('not-a-date');
  assertEq(bad, null, '无效日期返回null');

  const empty1 = RuleEngine.parseDateToMs('');
  assertEq(empty1, null, '空字符串返回null');

  // 确保日期大小关系正确
  const d1 = RuleEngine.parseDateToMs('2023-06-15');
  const d2 = RuleEngine.parseDateToMs('2023/06/16');
  const d3 = RuleEngine.parseDateToMs('2023年6月17日');
  const d4 = RuleEngine.parseDateToMs('1687267200000');
  assert(d1 < d2, 'ISO < 斜杠格式 顺序正确');
  assert(d2 < d3, '斜杠 < 中文日期 顺序正确');

  console.log('');

  // ================================================================
  // Test 2: 唯一键检测（单行重复检测）
  // ================================================================
  console.log('Test 2: 唯一键跨行状态维护 checkUniqueKey');

  const eng2 = new RuleEngine();
  eng2.rules = {
    global: { uniqueKeys: ['order_id'] },
    fields: {},
    crossField: []
  };
  eng2.reset();

  const r1 = eng2.checkUniqueKey({ order_id: 'ORD001', name: 'A' }, 2, 1);
  assertEq(r1.length, 0, '首次出现唯一键无冲突');

  const r2 = eng2.checkUniqueKey({ order_id: 'ORD002', name: 'B' }, 3, 2);
  assertEq(r2.length, 0, '第二个不同唯一键无冲突');

  const r3 = eng2.checkUniqueKey({ order_id: 'ORD001', name: 'A2' }, 4, 3);
  assertEq(r3.length, 1, '重复唯一键检测到1条冲突');
  assertEq(r3[0].type, 'unique_key', '冲突类型为 unique_key');
  assertEq(r3[0].firstOccurrence, 2, '记录首次出现行号=2');
  assertEq(r3[0].keyValues, ['ORD001'], '冲突键值正确');

  const violations = eng2.getAllUniqueKeyViolations();
  assertEq(violations.length, 1, 'getAllUniqueKeyViolations 返回1条记录');
  assertEq(violations[0].duplicateLine, 4, '重复行号=4');

  console.log('');

  // ================================================================
  // Test 3: 组合唯一键
  // ================================================================
  console.log('Test 3: 组合唯一键检测');

  const eng3 = new RuleEngine();
  eng3.rules = {
    global: { uniqueKeys: [['sku_id', 'warehouse']] },
    fields: {},
    crossField: []
  };
  eng3.reset();

  eng3.checkUniqueKey({ sku_id: 'SKU001', warehouse: '北京仓', qty: 10 }, 2, 1);
  eng3.checkUniqueKey({ sku_id: 'SKU001', warehouse: '上海仓', qty: 20 }, 3, 2);
  const cb1 = eng3.checkUniqueKey({ sku_id: 'SKU001', warehouse: '北京仓', qty: 30 }, 4, 3);
  assertEq(cb1.length, 1, '同sku同仓检测到冲突');

  const cb2 = eng3.checkUniqueKey({ sku_id: 'SKU002', warehouse: '北京仓', qty: 15 }, 5, 4);
  assertEq(cb2.length, 0, '不同sku同仓无冲突');

  console.log('');

  // ================================================================
  // Test 4: 跨字段日期比较（中文日期+时间戳）
  // ================================================================
  console.log('Test 4: 跨字段日期比较（中文日期+时间戳+混合）');

  const eng4 = new RuleEngine();
  eng4.rules = {
    global: {},
    fields: {},
    crossField: [{
      type: 'compare',
      left: 'delivery_date',
      operator: '>=',
      right: 'order_date',
      dataType: 'date',
      description: '发货日期应≥下单日期'
    }]
  };

  // case A: ISO vs ISO 正常
  const caseA = eng4._validateCrossField(
    { order_date: '2023-06-15', delivery_date: '2023-06-18' },
    eng4.rules.crossField[0]
  );
  assertEq(caseA, null, '[ISO vs ISO] 18号≥15号 通过');

  // case B: ISO vs ISO 失败
  const caseB = eng4._validateCrossField(
    { order_date: '2023-06-18', delivery_date: '2023-06-15' },
    eng4.rules.crossField[0]
  );
  assert(caseB !== null && caseB.severity === 'error', '[ISO vs ISO] 15号<18号 检测失败');

  // case C: 中文日期 vs ISO (正常)
  const caseC = eng4._validateCrossField(
    { order_date: '2023年6月15日', delivery_date: '2023-06-22' },
    eng4.rules.crossField[0]
  );
  assertEq(caseC, null, '[中文 vs ISO] 中文日期参与比较，22号≥15号 通过');

  // case D: 10位时间戳 vs 中文日期 (正常)
  const caseD = eng4._validateCrossField(
    { order_date: '1686758400', delivery_date: '2023年6月22日' },
    eng4.rules.crossField[0]
  );
  assertEq(caseD, null, '[10位ts vs 中文] 时间戳参与比较，22号≥15号 通过');

  // case E: 13位时间戳 vs ISO 失败
  // 1686758400000 = 2023-06-15, 2023-06-10 应该 < 15号
  const caseE = eng4._validateCrossField(
    { order_date: '1686758400000', delivery_date: '2023-06-10' },
    eng4.rules.crossField[0]
  );
  assert(caseE !== null, '[13位ms vs ISO] 10号<15号 检测失败');

  console.log('');

  // ================================================================
  // Test 5: validateRow 集成测试（唯一键+日期+字段规则）
  // ================================================================
  console.log('Test 5: validateRow 集成（含唯一键）');

  const tmpDir5 = makeTempDir();
  const rules5Path = path.join(tmpDir5, 'rules.yaml');
  fs.writeFileSync(rules5Path, `
global:
  uniqueKeys:
    - customer_id
fields:
  customer_id:
    required: true
    type: string
    pattern: '^C\\d{3}$'
  register_date:
    required: true
    type: date
    dateFormat: 'YYYY-MM-DD'
crossField:
  - type: compare
    left: register_date
    operator: '>='
    right: register_date
    dataType: date
    description: 日期应为有效
`, 'utf-8');

  const eng5 = new RuleEngine();
  eng5.load(rules5Path);

  // 第一行（合法中文日期）
  const v1 = eng5.validateRow(
    { customer_id: 'C001', register_date: '2023年4月18日' }, 2, 1
  );
  assertEq(v1.issues.filter(i => i.type === 'type').length, 0, 'C001中文日期类型校验通过（不再误判）');

  // 第二行：重复C001
  const v2 = eng5.validateRow(
    { customer_id: 'C001', register_date: '2023-01-15' }, 3, 2
  );
  assert(v2.issues.some(i => i.type === 'unique_key'), 'C001重复时检测到唯一键冲突');

  console.log('');

  // ================================================================
  // Test 6: 构造脏CSV并完整测试validate命令
  // ================================================================
  console.log('Test 6: 完整validate流程 - 唯一键+中文日期');

  const tmpDir6 = makeTempDir();
  const testCsv6 = path.join(tmpDir6, 'orders.csv');
  const rules6 = path.join(tmpDir6, 'rules.yaml');

  fs.writeFileSync(testCsv6, `order_id,customer_id,order_date,delivery_date,amount
ORD001,C001,2023-06-15,2023-06-18,100
ORD002,C002,2023年6月16日,2023/06/20,200
ORD001,C003,2023.06.17,1687267200000,300
ORD004,C004,1682995200,2023年4月18日,400
`, 'utf-8');

  fs.writeFileSync(rules6, `
global:
  uniqueKeys:
    - order_id
fields:
  order_id:
    required: true
    type: string
    pattern: '^ORD\\d{3}$'
  customer_id:
    required: true
    type: string
    pattern: '^C\\d{3}$'
  order_date:
    required: true
    type: date
  delivery_date:
    required: false
    type: date
  amount:
    required: true
    type: integer
    range:
      min: 0
      max: 100000
crossField:
  - type: compare
    left: delivery_date
    operator: '>='
    right: order_date
    dataType: date
    description: 发货日期应晚于或等于下单日期
`, 'utf-8');

  const eng6 = new RuleEngine();
  eng6.load(rules6);
  const reader6 = new CSVReader(testCsv6);
  await reader6.detect();

  let totalRows = 0;
  let uniqueKeyErrors = 0;
  let crossFieldErrors = 0;
  let typeErrorsDate = 0;
  await new Promise((resolve) => {
    reader6.read((row, lineNum, rowIndex) => {
      totalRows++;
      const res = eng6.validateRow(row, lineNum, rowIndex);
      for (const i of res.issues) {
        if (i.type === 'unique_key') uniqueKeyErrors++;
        if (i.type === 'cross_field') crossFieldErrors++;
        if (i.type === 'type' && i.field && (i.field.includes('date'))) typeErrorsDate++;
      }
    }, resolve);
  });

  assertEq(totalRows, 4, '读取到4行数据');
  assertEq(uniqueKeyErrors, 1, '检测到1个唯一键冲突（ORD001在行4）');
  assertEq(typeErrorsDate, 0, '所有日期格式（中文/时间戳/ISO/斜杠/点号）均通过类型检测，无误判');

  console.log('');

  // ================================================================
  // Test 7: 清洗+清洗后复验
  // ================================================================
  console.log('Test 7: 清洗前后规则复验（clean后validate应该无唯一键/日期问题）');

  const cleaner7 = new DataCleaner(testCsv6);
  const cleanCsv7 = path.join(tmpDir6, 'clean.csv');
  const cleanResult7 = await cleaner7.clean(rules6, cleanCsv7, {
    changelogPath: path.join(tmpDir6, 'changelog.json')
  });

  assert(cleanResult7.stats.removedDuplicates >= 1, `清洗删除了重复行(${cleanResult7.stats.removedDuplicates})`);

  // 对清洗后的数据再次validate
  const eng7 = new RuleEngine();
  eng7.load(rules6);
  const reader7 = new CSVReader(cleanCsv7);
  await reader7.detect();

  let afterUkErrors = 0;
  let afterDateTypeErrors = 0;
  let afterTotalRows = 0;
  await new Promise((resolve) => {
    reader7.read((row, lineNum, rowIndex) => {
      afterTotalRows++;
      const res = eng7.validateRow(row, lineNum, rowIndex);
      afterUkErrors += res.issues.filter(i => i.type === 'unique_key').length;
      afterDateTypeErrors += res.issues.filter(i => i.type === 'type' && i.field && i.field.includes('date')).length;
    }, resolve);
  });

  assertEq(afterUkErrors, 0, '清洗后唯一键冲突=0');
  assertEq(afterDateTypeErrors, 0, '清洗后日期类型错误=0（已统一格式）');

  console.log('');

  // ================================================================
  // Test 8: inventory 组合唯一键（sku_id+warehouse）
  // ================================================================
  console.log('Test 8: inventory 组合唯一键（sku_id + warehouse）');

  const invCsv = path.join(__dirname, 'samples', 'inventory.csv');
  const invRules = path.join(__dirname, 'samples', 'inventory.rules.yaml');

  const eng8 = new RuleEngine();
  eng8.load(invRules);
  const reader8 = new CSVReader(invCsv);
  await reader8.detect();

  let invUk = 0;
  await new Promise((resolve) => {
    reader8.read((row, lineNum, rowIndex) => {
      const res = eng8.validateRow(row, lineNum, rowIndex);
      invUk += res.issues.filter(i => i.type === 'unique_key').length;
    }, resolve);
  });

  assert(invUk >= 1, `库存数据检测到组合唯一键冲突(>=1), 实际=${invUk}`);

  // 清洗后复验
  const tmpDir8 = makeTempDir();
  const invClean = path.join(tmpDir8, 'inventory.clean.csv');
  const invCleaner = new DataCleaner(invCsv);
  await invCleaner.clean(invRules, invClean);

  const eng8b = new RuleEngine();
  eng8b.load(invRules);
  const reader8b = new CSVReader(invClean);
  await reader8b.detect();
  let invUkAfter = 0;
  await new Promise((resolve) => {
    reader8b.read((row, lineNum, rowIndex) => {
      const res = eng8b.validateRow(row, lineNum, rowIndex);
      invUkAfter += res.issues.filter(i => i.type === 'unique_key').length;
    }, resolve);
  });
  assertEq(invUkAfter, 0, '库存清洗后组合唯一键冲突=0');

  console.log('');

  // ================================================================
  // Test 9: customers 数据集 + orders 数据集（真实业务数据复测）
  // ================================================================
  console.log('Test 9: 真实数据集 customers + orders 验证');

  // customers
  const custCsv = path.join(__dirname, 'samples', 'customers.csv');
  const custRules = path.join(__dirname, 'samples', 'customers.rules.yaml');
  const eng9a = new RuleEngine();
  eng9a.load(custRules);
  const custReader = new CSVReader(custCsv);
  await custReader.detect();
  let custUk = 0;
  let custRows = 0;
  await new Promise((resolve) => {
    custReader.read((row, lineNum, rowIndex) => {
      custRows++;
      const res = eng9a.validateRow(row, lineNum, rowIndex);
      custUk += res.issues.filter(i => i.type === 'unique_key').length;
    }, resolve);
  });
  assert(custUk >= 1, `customers检测到唯一键冲突=${custUk}（C001/C003重复）`);

  // orders 跨字段日期比较
  const ordCsv = path.join(__dirname, 'samples', 'orders.csv');
  const ordRules = path.join(__dirname, 'samples', 'orders.rules.yaml');
  const eng9b = new RuleEngine();
  eng9b.load(ordRules);
  const ordReader = new CSVReader(ordCsv);
  await ordReader.detect();
  let ordCfDateOk = true;
  let ordTypeDateErr = 0;
  let ordCfWarn = 0;
  await new Promise((resolve) => {
    ordReader.read((row, lineNum, rowIndex) => {
      const res = eng9b.validateRow(row, lineNum, rowIndex);
      for (const i of res.issues.concat(res.warnings)) {
        if (i.type === 'cross_field' && i.message && i.message.includes('日期解析失败')) {
          ordCfDateOk = false;
        }
        if (i.type === 'type' && i.field && ['order_date', 'delivery_date'].includes(i.field)) {
          ordTypeDateErr++;
        }
        if (i.severity === 'warning' && i.type === 'cross_field') ordCfWarn++;
      }
    }, resolve);
  });
  assert(ordCfDateOk, 'orders中跨字段日期比较（含中文日期/时间戳/ISO/斜杠/点号）全部能正常解析，无"日期解析失败"告警');
  assertEq(ordTypeDateErr, 0, 'orders中日期字段（含各种格式）全部通过type=date检测');

  console.log('');

  // ================================================================
  // 结果汇总
  // ================================================================
  console.log('========================================');
  console.log(`  测试结果: 通过 ${passed}, 失败 ${failed}`);
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('测试执行出错:', err);
  console.error(err.stack);
  process.exit(2);
});
