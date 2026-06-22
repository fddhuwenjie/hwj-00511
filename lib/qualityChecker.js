const CSVReader = require('./csvReader');

const DATE_PATTERNS = [
  { regex: /^\d{4}-\d{2}-\d{2}$/, format: 'YYYY-MM-DD' },
  { regex: /^\d{4}\/\d{2}\/\d{2}$/, format: 'YYYY/MM/DD' },
  { regex: /^\d{4}\.\d{2}\.\d{2}$/, format: 'YYYY.MM.DD' },
  { regex: /^\d{2}-\d{2}-\d{4}$/, format: 'DD-MM-YYYY' },
  { regex: /^\d{2}\/\d{2}\/\d{4}$/, format: 'DD/MM/YYYY' },
  { regex: /^\d{4}年\d{1,2}月\d{1,2}日$/, format: 'YYYY年M月D日' },
  { regex: /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/, format: 'ISO datetime' },
  { regex: /^\d{13}$/, format: 'Unix ms timestamp' },
  { regex: /^\d{10}$/, format: 'Unix timestamp' }
];

function inferType(values) {
  const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
  if (nonEmpty.length === 0) return { type: 'empty', confidence: 1 };

  let intCount = 0, floatCount = 0, boolCount = 0, dateCount = 0, dateFormats = {};
  const lengthSum = nonEmpty.reduce((s, v) => s + String(v).length, 0);
  const avgLength = lengthSum / nonEmpty.length;

  for (const v of nonEmpty) {
    const s = String(v).trim();
    if (/^-?\d+$/.test(s)) intCount++;
    else if (/^-?\d*\.\d+$/.test(s) || /^-?\d+\.?\d*e[+-]?\d+$/i.test(s)) floatCount++;

    if (['true', 'false', '是', '否', 'yes', 'no', '1', '0', 'y', 'n'].includes(s.toLowerCase())) boolCount++;

    for (const p of DATE_PATTERNS) {
      if (p.regex.test(s)) {
        dateCount++;
        dateFormats[p.format] = (dateFormats[p.format] || 0) + 1;
        break;
      }
    }
  }

  const total = nonEmpty.length;
  const boolRatio = boolCount / total;
  const intRatio = intCount / total;
  const floatRatio = floatCount / total;
  const numRatio = (intCount + floatCount) / total;
  const dateRatio = dateCount / total;

  if (boolRatio > 0.9 && (boolCount > 5 || total < 10)) {
    return { type: 'boolean', confidence: boolRatio };
  }
  if (numRatio > 0.9) {
    return { type: intRatio > 0.9 ? 'integer' : 'number', confidence: numRatio };
  }
  if (dateRatio > 0.8) {
    const topFormat = Object.entries(dateFormats).sort((a, b) => b[1] - a[1])[0];
    return { type: 'date', confidence: dateRatio, format: topFormat ? topFormat[0] : 'unknown' };
  }

  const uniqueValues = new Set(nonEmpty.map(v => String(v).trim()));
  const uniqueRatio = uniqueValues.size / nonEmpty.length;
  if (uniqueRatio < 0.05 && uniqueValues.size <= 50 && nonEmpty.length > 20) {
    return { type: 'enum', confidence: 1 - uniqueRatio, values: Array.from(uniqueValues) };
  }

  return { type: 'string', confidence: Math.max(0.5, 1 - numRatio - dateRatio), avgLength };
}

function computeStats(values, type) {
  const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
  const stats = {
    count: values.length,
    empty: values.length - nonEmpty.length,
    emptyRate: (values.length - nonEmpty.length) / values.length,
    unique: new Set(nonEmpty.map(v => String(v))).size
  };

  if (type === 'integer' || type === 'number') {
    const nums = nonEmpty.map(v => parseFloat(String(v))).filter(n => !isNaN(n));
    if (nums.length > 0) {
      nums.sort((a, b) => a - b);
      stats.min = nums[0];
      stats.max = nums[nums.length - 1];
      stats.mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      stats.median = nums[Math.floor(nums.length / 2)];
      stats.q1 = nums[Math.floor(nums.length * 0.25)];
      stats.q3 = nums[Math.floor(nums.length * 0.75)];
      const iqr = stats.q3 - stats.q1;
      const lower = stats.q1 - 1.5 * iqr;
      const upper = stats.q3 + 1.5 * iqr;
      stats.outliers = nums.filter(n => n < lower || n > upper).length;
      const variance = nums.reduce((s, n) => s + (n - stats.mean) ** 2, 0) / nums.length;
      stats.stddev = Math.sqrt(variance);
    }
  }

  if (type === 'string' || !stats.avgLength) {
    const lengths = nonEmpty.map(v => String(v).length);
    if (lengths.length > 0) {
      lengths.sort((a, b) => a - b);
      stats.avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      stats.minLength = lengths[0];
      stats.maxLength = lengths[lengths.length - 1];
      stats.medianLength = lengths[Math.floor(lengths.length / 2)];
    }
  }

  if (type === 'date') {
    const formats = {};
    for (const v of nonEmpty) {
      for (const p of DATE_PATTERNS) {
        if (p.regex.test(String(v).trim())) {
          formats[p.format] = (formats[p.format] || 0) + 1;
          break;
        }
      }
    }
    stats.dateFormats = formats;
    stats.formatChaos = Object.keys(formats).length > 1;
  }

  return stats;
}

class QualityChecker {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.options = options;
    this.columnData = {};
    this.rows = [];
    this.duplicates = new Map();
    this.rowSignatures = new Map();
    this.problems = [];
  }

  async profile() {
    const reader = new CSVReader(this.filePath, this.options);
    const detection = await reader.detect();

    return new Promise((resolve, reject) => {
      reader.read(
        (row, lineNum, rowIndex) => {
          if (!this.header) {
            this.header = reader.header;
            this.header.forEach(h => { this.columnData[h] = []; });
          }
          this.rows.push({ ...row, __lineNum: lineNum, __rowIndex: rowIndex });
          this.header.forEach(h => {
            this.columnData[h].push(row[h]);
          });

          const sig = this.header.map(h => String(row[h] || '')).join('\x00');
          if (this.rowSignatures.has(sig)) {
            const first = this.rowSignatures.get(sig);
            if (!this.duplicates.has(sig)) {
              this.duplicates.set(sig, [first, lineNum]);
            } else {
              this.duplicates.get(sig).push(lineNum);
            }
          } else {
            this.rowSignatures.set(sig, lineNum);
          }
        },
        (info) => {
          const result = this._computeReport(detection);
          resolve(result);
        }
      );
      reader.on('error', reject);
    });
  }

  _computeReport(detection) {
    const columns = {};
    let totalEmptyCells = 0;
    let totalCells = 0;
    const columnProblems = [];

    for (const col of this.header) {
      const values = this.columnData[col];
      const typeInfo = inferType(values);
      const stats = computeStats(values, typeInfo.type);
      totalEmptyCells += stats.empty;
      totalCells += values.length;

      const colIssues = [];
      if (stats.emptyRate > 0.1) {
        colIssues.push({ severity: stats.emptyRate > 0.3 ? 'high' : 'medium', type: 'empty_rate', message: `空值率 ${(stats.emptyRate * 100).toFixed(1)}%` });
      }
      if (typeInfo.confidence < 0.8 && typeInfo.type !== 'empty') {
        colIssues.push({ severity: 'medium', type: 'mixed_types', message: `类型混乱，推断置信度 ${(typeInfo.confidence * 100).toFixed(1)}%` });
      }
      if (typeInfo.type === 'date' && stats.formatChaos) {
        colIssues.push({ severity: 'high', type: 'date_format', message: `日期格式混乱: ${Object.keys(stats.dateFormats || {}).join(', ')}` });
      }
      if ((typeInfo.type === 'integer' || typeInfo.type === 'number') && stats.outliers > 0) {
        colIssues.push({ severity: 'medium', type: 'outliers', message: `疑似异常值 ${stats.outliers} 个` });
      }
      if (typeInfo.type === 'string' && stats.maxLength > stats.avgLength * 5 && stats.maxLength > 100) {
        colIssues.push({ severity: 'low', type: 'length_anomaly', message: `长度异常 (平均 ${stats.avgLength.toFixed(0)}, 最大 ${stats.maxLength})` });
      }

      columns[col] = { ...typeInfo, stats, issues: colIssues };
      for (const issue of colIssues) {
        columnProblems.push({ column: col, ...issue });
      }
    }

    const duplicateRows = Array.from(this.duplicates.values()).reduce((sum, arr) => sum + arr.length - 1, 0);
    const uniqueRowRate = this.rows.length > 0 ? (this.rowSignatures.size / this.rows.length) : 1;

    let score = 100;
    score -= (totalEmptyCells / Math.max(1, totalCells)) * 30;
    score -= (duplicateRows / Math.max(1, this.rows.length)) * 20;
    for (const p of columnProblems) {
      if (p.severity === 'high') score -= 5;
      else if (p.severity === 'medium') score -= 2;
      else score -= 0.5;
    }
    score = Math.max(0, Math.min(100, Math.round(score * 10) / 10));

    const allProblems = [
      ...columnProblems,
      ...(duplicateRows > 0 ? [{ column: '__global__', severity: duplicateRows > this.rows.length * 0.05 ? 'high' : 'medium', type: 'duplicate_rows', message: `重复行 ${duplicateRows} 条` }] : [])
    ];
    allProblems.sort((a, b) => {
      const sev = { high: 0, medium: 1, low: 2 };
      return sev[a.severity] - sev[b.severity];
    });

    return {
      file: this.filePath,
      detection,
      rowCount: this.rows.length,
      columnCount: this.header.length,
      header: this.header,
      duplicateRows,
      uniqueRowRate,
      totalEmptyRate: totalCells > 0 ? totalEmptyCells / totalCells : 0,
      columns,
      problems: allProblems,
      score,
      grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'
    };
  }
}

module.exports = { QualityChecker, inferType, DATE_PATTERNS };
