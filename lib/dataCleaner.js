const fs = require('fs');
const path = require('path');
const CSVReader = require('./csvReader');
const RuleEngine = require('./ruleEngine');

class DataCleaner {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.options = options;
    this.ruleEngine = new RuleEngine();
    this.changelog = [];
    this.reviewRecords = [];
    this.removedDuplicates = [];
    this.stats = {
      totalRows: 0,
      changedRows: 0,
      changedFields: 0,
      removedDuplicates: 0,
      reviewRows: 0
    };
  }

  async clean(rulesPath, outputPath, options = {}) {
    if (rulesPath) this.ruleEngine.load(rulesPath);

    const reader = new CSVReader(this.filePath, this.options);
    await reader.detect();
    const delimiter = reader.delimiter;

    return new Promise((resolve, reject) => {
      let header = null;
      const outputLines = [];
      const seenKeys = new Map();
      const uniqueKeys = this.ruleEngine.getUniqueKeys();
      const dedupFull = !uniqueKeys.length;
      const seenFull = new Set();

      reader.read(
        (row, lineNum, rowIndex) => {
          if (!header) {
            header = reader.header;
            outputLines.push(header.map(h => CSVReader._escapeField(h, delimiter)).join(delimiter));
          }

          this.stats.totalRows++;
          let newRow = { ...row };
          let rowChanged = false;
          const rowChanges = [];
          const rowIssues = [];

          for (const field of header) {
            const rule = this.ruleEngine.getFieldRule(field);
            const result = this.ruleEngine.cleanField(field, newRow[field], rule);
            if (result.changed) {
              rowChanges.push({ field, from: result.original, to: result.value });
              newRow[field] = result.value;
              rowChanged = true;
              this.stats.changedFields++;
            }
          }

          const validation = this.ruleEngine.validateRow(newRow, lineNum, rowIndex);
          if (validation.issues.length > 0 || validation.warnings.length > 0) {
            rowIssues.push(...validation.issues, ...validation.warnings);
          }

          let isDuplicate = false;
          if (dedupFull) {
            const sig = header.map(h => String(newRow[h] || '')).join('\x00');
            if (seenFull.has(sig)) {
              isDuplicate = true;
              this.removedDuplicates.push({ lineNum, row: newRow, reason: 'full_duplicate' });
            } else {
              seenFull.add(sig);
            }
          } else {
            const keySig = uniqueKeys.map(k => String(newRow[k] || '')).join('\x00');
            if (keySig && uniqueKeys.every(k => newRow[k] !== '')) {
              if (seenKeys.has(keySig)) {
                isDuplicate = true;
                this.removedDuplicates.push({ lineNum, row: newRow, reason: `unique_key_duplicate: ${uniqueKeys.join('+')}` });
              } else {
                seenKeys.set(keySig, lineNum);
              }
            }
          }

          if (isDuplicate) {
            this.stats.removedDuplicates++;
            this.changelog.push({ lineNum, action: 'remove_duplicate', reason: this.removedDuplicates[this.removedDuplicates.length - 1].reason });
            if (options.includeReview) {
              this.reviewRecords.push({
                lineNum,
                action: 'duplicate',
                problems: ['重复行'],
                suggestions: ['删除'],
                original: JSON.parse(JSON.stringify(newRow)),
                approved: JSON.parse(JSON.stringify(newRow))
              });
            }
            return;
          }

          if (rowIssues.length > 0 && options.includeReview) {
            const approved = {};
            for (const f of header) approved[f] = newRow[f];
            this.reviewRecords.push({
              lineNum,
              action: rowChanged ? 'modified' : 'original',
              problems: rowIssues.map(i => `${i.severity}: ${i.message}`),
              suggestions: rowIssues.map(i => this._suggestFix(i, newRow)),
              original: JSON.parse(JSON.stringify(row)),
              approved
            });
            this.stats.reviewRows++;
          }

          if (rowChanged) {
            this.stats.changedRows++;
            this.changelog.push({ lineNum, action: 'modify', changes: rowChanges });
          }

          outputLines.push(header.map(h => CSVReader._escapeField(newRow[h] !== undefined ? newRow[h] : '', delimiter)).join(delimiter));
        },
        () => {
          if (outputPath) {
            fs.writeFileSync(outputPath, outputLines.join('\r\n') + '\r\n', 'utf-8');
          }

          const changelogPath = options.changelogPath || (outputPath ? outputPath.replace(/\.csv$/i, '') + '.changelog.json' : null);
          if (changelogPath) {
            fs.writeFileSync(changelogPath, JSON.stringify({
              source: this.filePath,
              output: outputPath,
              timestamp: new Date().toISOString(),
              stats: this.stats,
              changelog: this.changelog,
              removedDuplicates: this.removedDuplicates
            }, null, 2), 'utf-8');
          }

          if (options.includeReview && options.reviewPath) {
            this._writeReviewCsv(options.reviewPath, header);
          }

          resolve({
            stats: this.stats,
            outputPath,
            changelogPath,
            reviewPath: options.reviewPath || null
          });
        }
      );
      reader.on('error', reject);
    });
  }

  _suggestFix(issue, row) {
    switch (issue.type) {
      case 'required': return `填充缺失值，建议：${this._guessFillValue(issue.field, row)}`;
      case 'type': return `修正类型为 ${issue.field} 对应类型`;
      case 'enum': return `修正枚举值`;
      case 'pattern': return `修正为匹配正则格式`;
      case 'range': return `修正到合法范围`;
      case 'cross_field': return `调整相关字段值`;
      default: return `手动检查并修正`;
    }
  }

  _guessFillValue(field, row) {
    return '（请补充）';
  }

  _writeReviewCsv(reviewPath, header) {
    const reviewHeaders = ['line_num', 'action', 'problems', 'suggestions', ...header.map(h => `orig_${h}`), ...header.map(h => `fix_${h}`)];
    const lines = [reviewHeaders.map(h => CSVReader._escapeField(h, ',')).join(',')];

    for (const rec of this.reviewRecords) {
      const row = [
        rec.lineNum,
        rec.action,
        rec.problems.join(' | '),
        rec.suggestions.join(' | '),
        ...header.map(h => rec.original[h] !== undefined ? rec.original[h] : ''),
        ...header.map(h => rec.approved[h] !== undefined ? rec.approved[h] : '')
      ];
      lines.push(row.map(v => CSVReader._escapeField(v, ',')).join(','));
    }

    fs.writeFileSync(reviewPath, lines.join('\r\n') + '\r\n', 'utf-8');
  }

  static async mergeReview(originalCsv, reviewCsv, outputCsv, options = {}) {
    const reader1 = new CSVReader(originalCsv, options);
    await reader1.detect();
    const originalData = [];
    const originalLines = [];
    let header = null;

    await new Promise((resolve, reject) => {
      reader1.read((row, lineNum) => {
        if (!header) header = reader1.header;
        originalData.push({ row, lineNum });
        originalLines.push(lineNum);
      }, resolve);
      reader1.on('error', reject);
    });

    const reviewReader = new CSVReader(reviewCsv, { ...options, hasHeader: true });
    await reviewReader.detect();
    const reviewMap = new Map();

    await new Promise((resolve, reject) => {
      reviewReader.read((row) => {
        const lineNum = parseInt(row['line_num']);
        if (lineNum) reviewMap.set(lineNum, row);
      }, resolve);
      reviewReader.on('error', reject);
    });

    const delimiter = reader1.delimiter;
    const outLines = [header.map(h => CSVReader._escapeField(h, delimiter)).join(delimiter)];

    for (const { row, lineNum } of originalData) {
      let outRow = { ...row };
      const review = reviewMap.get(lineNum);
      if (review) {
        for (const h of header) {
          const fixKey = `fix_${h}`;
          if (review[fixKey] !== undefined && review[fixKey] !== '') {
            outRow[h] = review[fixKey];
          }
        }
      }
      outLines.push(header.map(h => CSVReader._escapeField(outRow[h] !== undefined ? outRow[h] : '', delimiter)).join(delimiter));
    }

    fs.writeFileSync(outputCsv, outLines.join('\r\n') + '\r\n', 'utf-8');
    return { merged: reviewMap.size, output: outputCsv };
  }
}

module.exports = DataCleaner;
