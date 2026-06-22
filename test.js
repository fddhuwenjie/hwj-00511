const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('yaml');
const RuleEngine = require('./lib/ruleEngine');
const CSVReader = require('./lib/csvReader');
const { QualityChecker } = require('./lib/qualityChecker');
const DataCleaner = require('./lib/dataCleaner');
const RuleAuditor = require('./lib/ruleAuditor');

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
  // Test 10: 规则审计 - 覆盖率 & 未约束字段检测
  // ================================================================
  console.log('Test 10: 规则审计 - 覆盖率与未约束字段检测');

  const tmpDir10 = makeTempDir();
  const auditCsv10 = path.join(tmpDir10, 'audit.csv');
  const auditRules10 = path.join(tmpDir10, 'audit.rules.yaml');

  const csvLines = ['id,name,category,created_at,updated_at,price,quantity,total,status,remark'];
  const categories = ['电子产品', '图书', '服装'];
  const statuses = ['active', 'active', 'active', 'active', 'inactive', 'pending'];
  let idx = 1;
  for (let batch = 0; batch < 30; batch++) {
    for (let ci = 0; ci < 3; ci++) {
      const id = 'R' + String(idx).padStart(3, '0');
      const cat = categories[ci];
      const y = 2023 + Math.floor(idx / 12);
      const m = ((idx - 1) % 12) + 1;
      const d = ((idx * 3) % 27) + 1;
      const price = (10 + idx * 7) % 500 + 10;
      const qty = (idx % 5) + 1;
      const status = statuses[idx % statuses.length];
      const sep1 = idx % 3 === 0 ? '-' : idx % 3 === 1 ? '/' : '.';
      const sep2 = idx % 4 === 0 ? '年' : '-';
      let dt1, dt2;
      if (idx % 5 === 0) {
        dt1 = `${y}年${m}月${d}日`;
      } else {
        dt1 = `${y}${sep1}${String(m).padStart(2, '0')}${sep1}${String(d).padStart(2, '0')}`;
      }
      dt2 = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d + 5, 28)).padStart(2, '0')}`;
      csvLines.push(`${id},商品${idx},${cat},${dt1},${dt2},${price},${qty},${price * qty},${status},备注${idx}`);
      idx++;
    }
  }
  fs.writeFileSync(auditCsv10, csvLines.join('\n'), 'utf-8');

  fs.writeFileSync(auditRules10, `
fields:
  id:
    required: true
    type: string
    pattern: '^R\\d{3}$'
  name:
    required: true
    type: string
    trim: true
  status:
    required: true
    type: enum
    enum:
      - active
      - inactive
      - pending
`, 'utf-8');

  const auditor10 = new RuleAuditor(auditCsv10, auditRules10);
  const report10 = await auditor10.audit();

  assert(report10.coverage.totalFields === 10, '检测到10个CSV字段 (实际=' + report10.coverage.totalFields + ')');
  assert(report10.coverage.coveredFields === 3, '规则覆盖3个字段 (实际=' + report10.coverage.coveredFields + ')');
  assert(report10.coverage.uncoveredFields === 7, '未覆盖7个字段 (实际=' + report10.coverage.uncoveredFields + ')');
  assert(report10.coverage.coverageRate === 0.3, '覆盖率0.3 (实际=' + report10.coverage.coverageRate + ')');
  assert(report10.coverage.uncoveredFieldNames.includes('category'), '未覆盖字段包含category');
  assert(report10.coverage.uncoveredFieldNames.includes('price'), '未覆盖字段包含price');
  assert(report10.coverage.uncoveredFieldNames.includes('created_at'), '未覆盖字段包含created_at');
  assert(report10.coverage.uncoveredFieldNames.includes('updated_at'), '未覆盖字段包含updated_at');
  assert(report10.coverage.uncoveredFieldNames.includes('quantity'), '未覆盖字段包含quantity');
  assert(report10.coverage.uncoveredFieldNames.includes('total'), '未覆盖字段包含total');
  assert(report10.coverage.uncoveredFieldNames.includes('remark'), '未覆盖字段包含remark');

  const unconstrained = report10.unconstrainedFields;
  assert(unconstrained.length >= 7, 'unconstrainedFields 返回7条 (实际=' + unconstrained.length + ')');

  const categoryField = unconstrained.find(f => f.field === 'category');
  assert(categoryField !== undefined, '检测到category字段无约束');
  assert(categoryField.inferredType === 'enum' || categoryField.inferredType === 'string', 'category推断类型正确 (实际=' + categoryField.inferredType + ')');
  assert(categoryField.sampleValues.length > 0, 'category包含样例行');
  assert(categoryField.sampleValues[0].lineNum !== undefined, '样例行包含行号');

  console.log('');

  // ================================================================
  // Test 11: 规则审计 - 枚举候选发现
  // ================================================================
  console.log('Test 11: 规则审计 - 枚举候选发现');

  assert(report10.enumCandidates.length >= 1, '检测到至少1个枚举候选(实际=' + report10.enumCandidates.length + ')');
  const enumCat = report10.enumCandidates.find(e => e.field === 'category');
  assert(enumCat !== undefined, 'category字段被识别为枚举候选');
  assert(enumCat.confidence > 0.5, '枚举候选置信度>0.5');
  assert(enumCat.candidateValues.length >= 3, 'category至少3个候选值');
  assert(enumCat.sampleRows && enumCat.sampleRows.length > 0, '枚举候选包含样例行');
  assert(enumCat.valueDistribution && enumCat.valueDistribution.length > 0, '枚举候选包含值分布');

  console.log('');

  // ================================================================
  // Test 12: 规则审计 - 日期格式建议
  // ================================================================
  console.log('Test 12: 规则审计 - 日期格式混用分析');

  assert(report10.dateFormatIssues.length >= 2, '检测到至少2个日期格式问题(实际=' + report10.dateFormatIssues.length + ')');

  const createdAtIssue = report10.dateFormatIssues.find(d => d.field === 'created_at');
  assert(createdAtIssue !== undefined, 'created_at被识别为日期字段');
  assert(createdAtIssue.mixedCount > 1, 'created_at格式数>1(实际=' + createdAtIssue.mixedCount + ')');
  assert(createdAtIssue.detectedFormats.length >= 2, 'created_at检测到至少2种格式');
  assert(createdAtIssue.sampleRows.length > 0, '日期格式问题包含样例行');

  const updatedAtIssue = report10.dateFormatIssues.find(d => d.field === 'updated_at');
  assert(updatedAtIssue !== undefined, 'updated_at被识别为日期字段');
  assert(updatedAtIssue.isDateField === false, 'updated_at当前未配置为日期类型');

  const dateTypeSuggestions = report10.suggestions.filter(s =>
    s.category === 'date_field_suggestion' || s.category === 'date_format_mixed'
  );
  assert(dateTypeSuggestions.length >= 1, '至少1条日期相关建议(实际=' + dateTypeSuggestions.length + ')');
  assert(dateTypeSuggestions[0].yamlSnippet.includes('date'), '日期建议YAML包含type: date');
  assert(dateTypeSuggestions[0].evidence.sampleRows && dateTypeSuggestions[0].evidence.sampleRows.length > 0, '日期建议包含样例行');

  console.log('');

  // ================================================================
  // Test 13: 规则审计 - 唯一键候选识别
  // ================================================================
  console.log('Test 13: 规则审计 - 唯一键候选识别');

  const ukCandidates = report10.uniqueKeyRisks.filter(r => r.type === 'unique_key_candidate');
  assert(ukCandidates.length >= 1, '检测到至少1个唯一键候选(实际=' + ukCandidates.length + ')');
  const idUk = ukCandidates.find(r => r.keyFields.includes('id'));
  assert(idUk !== undefined, 'id字段被识别为唯一键候选');
  assert(idUk.confidence > 0.7, '唯一键候选置信度>0.7(实际=' + idUk.confidence + ')');
  assert(idUk.uniqueRatio > 0.9, '唯一值比例>0.9(实际=' + idUk.uniqueRatio + ')');

  const ukSuggestion = report10.suggestions.find(s => s.category === 'unique_key_candidate');
  assert(ukSuggestion !== undefined, '生成唯一键建议');
  assert(ukSuggestion.yamlSnippet.includes('uniqueKeys'), '唯一键建议YAML包含uniqueKeys');
  assert(ukSuggestion.evidence.sampleRows !== undefined, '唯一键建议包含证据');

  console.log('');

  // ================================================================
  // Test 14: 规则审计 - 跨字段规则风险提示
  // ================================================================
  console.log('Test 14: 规则审计 - 跨字段规则发现（created_at <= updated_at & total=price*quantity）');

  const crossFieldSuggestions = report10.suggestions.filter(s => s.category === 'cross_field_suggestion');
  assert(crossFieldSuggestions.length >= 1, '至少1条跨字段建议(实际=' + crossFieldSuggestions.length + ')');

  const datePairSuggestion = crossFieldSuggestions.find(s =>
    s.yamlSnippet && s.yamlSnippet.includes('compare') &&
    (s.yamlSnippet.includes('created_at') || s.yamlSnippet.includes('updated_at'))
  );
  assert(datePairSuggestion !== undefined, '检测到日期对跨字段建议(created_at <= updated_at)');
  assert(datePairSuggestion.confidence > 0.6, '跨字段建议置信度>0.6');
  assert(datePairSuggestion.evidence && datePairSuggestion.evidence.sampleRows !== undefined, '跨字段建议包含样例行');

  const productSuggestion = crossFieldSuggestions.find(s =>
    s.yamlSnippet && s.yamlSnippet.includes('expression') &&
    s.yamlSnippet.includes('total')
  );
  assert(productSuggestion !== undefined || crossFieldSuggestions.some(s => s.description.includes('×')) || crossFieldSuggestions.some(s => s.description.includes('total')), '检测到 total=price*quantity 表达式建议');

  console.log('');

  // ================================================================
  // Test 15: 规则审计 - 建议置信度与YAML片段有效性
  // ================================================================
  console.log('Test 15: 规则审计 - 建议置信度/YAML片段/样例行完整');

  assert(report10.suggestions.length >= 5, '至少5条修复建议(实际=' + report10.suggestions.length + ')');
  for (const s of report10.suggestions) {
    assert(typeof s.id === 'string' && s.id.length > 0, '建议有id: ' + s.id);
    assert(typeof s.title !== undefined && s.title.length > 0, '建议' + s.id + '有title');
    assert(typeof s.confidence === 'number' && s.confidence >= 0 && s.confidence <= 1, '建议' + s.id + '置信度在0-1之间');
    assert(['high', 'medium', 'low'].includes(s.confidenceLabel), '建议' + s.id + '置信度标签有效');
    assert(typeof s.yamlSnippet && s.yamlSnippet.length > 0, '建议' + s.id + '有YAML片段');
    assert(s.evidence !== undefined, '建议' + s.id + '有evidence');
    const parsed = yaml.parse(s.yamlSnippet);
    assert(parsed !== null && typeof parsed === 'object', '建议' + s.id + ' YAML可解析');
  }

  const unconstrainedSuggestion = report10.suggestions.find(s => s.category === 'unconstrained_field');
  assert(unconstrainedSuggestion !== undefined, '存在未约束字段建议');
  assert(unconstrainedSuggestion.evidence.sampleRows && unconstrainedSuggestion.evidence.sampleRows.length > 0, '未约束字段建议包含样例行');
  assert(unconstrainedSuggestion.evidence.sampleRows[0].lineNum !== undefined, '样例行包含行号');
  assert(unconstrainedSuggestion.evidence.sampleRows[0].value !== undefined, '样例行包含值');

  console.log('');

  // ================================================================
  // Test 16: 规则审计 - 报告导出 (Markdown + JSON)
  // ================================================================
  console.log('Test 16: 规则审计 - Markdown/JSON报告导出');

  const mdPath = path.join(tmpDir10, 'audit-report.md');
  const jsonPath = path.join(tmpDir10, 'audit-report.json');

  RuleAuditor.writeMarkdownReport(report10, mdPath);
  RuleAuditor.writeJsonReport(report10, jsonPath);

  assert(fs.existsSync(mdPath), 'Markdown报告文件已生成');
  assert(fs.existsSync(jsonPath), 'JSON报告文件已生成');

  const mdContent = fs.readFileSync(mdPath, 'utf-8');
  assert(mdContent.includes('# CSV 规则审计报告'), 'Markdown包含标题');
  assert(mdContent.includes('规则覆盖率'), 'Markdown包含覆盖率章节');
  assert(mdContent.includes('修复建议'), 'Markdown包含修复建议章节');
  assert(mdContent.includes('```yaml'), 'Markdown包含YAML代码块');

  const jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  assert(jsonContent.coverage !== undefined, 'JSON包含coverage');
  assert(jsonContent.suggestions && jsonContent.suggestions.length > 0, 'JSON包含suggestions');
  assert(jsonContent.unconstrainedFields && jsonContent.unconstrainedFields.length > 0, 'JSON包含unconstrainedFields');
  assert(jsonContent.enumCandidates !== undefined, 'JSON包含enumCandidates');
  assert(jsonContent.dateFormatIssues !== undefined, 'JSON包含dateFormatIssues');
  assert(jsonContent.uniqueKeyRisks !== undefined, 'JSON包含uniqueKeyRisks');
  assert(jsonContent.crossFieldRuleHits !== undefined, 'JSON包含crossFieldRuleHits');

  console.log('');

  // ================================================================
  // Test 17: 规则审计 - 真实数据集审计（与现有规则数据冲突检测）
  // ================================================================
  console.log('Test 17: 规则审计 - 真实数据集customers规则-数据冲突检测');

  const custAuditCsv = path.join(__dirname, 'samples', 'customers.csv');
  const custAuditRules = path.join(__dirname, 'samples', 'customers.rules.yaml');
  const auditor17 = new RuleAuditor(custAuditCsv, custAuditRules);
  const report17 = await auditor17.audit();

  assert(report17.coverage.coverageRate > 0.8, 'customers规则覆盖率>0.8');
  assert(report17.ruleDataConflicts.length >= 1, '检测到至少1条规则数据冲突(实际=' + report17.ruleDataConflicts.length + ')');

  const enumConflict = report17.ruleDataConflicts.find(c => c.type === 'enum_out_of_range');
  assert(enumConflict !== undefined, '检测到枚举值超范围冲突');
  assert(enumConflict.violationCount > 0, '枚举冲突有违反数');
  assert(enumConflict.sampleRows.length > 0, '枚举冲突有样例行');

  assert(report17.uniqueKeyRisks.length >= 1, 'customers检测到唯一键重复风险');

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
