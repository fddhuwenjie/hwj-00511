const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const CSVReader = require('./csvReader');
const RuleEngine = require('./ruleEngine');
const { QualityChecker, inferType, DATE_PATTERNS } = require('./qualityChecker');

class RuleAuditor {
  constructor(csvPath, rulesPath, options = {}) {
    this.csvPath = csvPath;
    this.rulesPath = rulesPath;
    this.options = options;
    this.ruleEngine = new RuleEngine();
    this.rows = [];
    this.header = [];
    this.columnData = {};
    this.suggestions = [];
  }

  async audit() {
    this.ruleEngine.load(this.rulesPath);
    const rules = this.ruleEngine.rules;

    const reader = new CSVReader(this.csvPath);
    await reader.detect();

    await new Promise((resolve, reject) => {
      reader.read(
        (row, lineNum, rowIndex) => {
          if (!this.header.length) {
            this.header = reader.header;
            this.header.forEach(h => { this.columnData[h] = []; });
          }
          this.rows.push({ ...row, __lineNum: lineNum, __rowIndex: rowIndex });
          this.header.forEach(h => {
            this.columnData[h].push(row[h]);
          });
        },
        () => resolve()
      );
      reader.on('error', reject);
    });

    const report = {
      source: {
        csvFile: this.csvPath,
        rulesFile: this.rulesPath,
        totalRows: this.rows.length,
        totalColumns: this.header.length,
        generatedAt: new Date().toISOString()
      },
      coverage: this._analyzeCoverage(rules),
      unconstrainedFields: this._findUnconstrainedFields(rules),
      ruleDataConflicts: this._analyzeRuleDataConflicts(rules),
      enumCandidates: this._discoverEnumCandidates(rules),
      dateFormatIssues: this._analyzeDateFormats(rules),
      uniqueKeyRisks: this._analyzeUniqueKeyRisks(rules),
      crossFieldRuleHits: this._analyzeCrossFieldRules(rules),
      suggestions: []
    };

    report.suggestions = this._generateSuggestions(report);
    report.markdown = this._generateMarkdownReport(report);

    return report;
  }

  _analyzeCoverage(rules) {
    const ruleFields = Object.keys(rules.fields || {});
    const coveredFields = this.header.filter(h => ruleFields.includes(h));
    const uncoveredFields = this.header.filter(h => !ruleFields.includes(h));

    return {
      totalFields: this.header.length,
      coveredFields: coveredFields.length,
      uncoveredFields: uncoveredFields.length,
      coverageRate: this.header.length > 0 ? coveredFields.length / this.header.length : 0,
      coveredFieldNames: coveredFields,
      uncoveredFieldNames: uncoveredFields,
      hasGlobalUniqueKeys: (rules.global?.uniqueKeys?.length || 0) > 0,
      hasCrossFieldRules: (rules.crossField?.length || 0) > 0
    };
  }

  _findUnconstrainedFields(rules) {
    const ruleFields = Object.keys(rules.fields || {});
    const result = [];

    for (const field of this.header) {
      if (!ruleFields.includes(field)) {
        const values = this.columnData[field];
        const typeInfo = inferType(values);
        const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
        const sampleRows = [];
        for (let i = 0; i < Math.min(3, this.rows.length); i++) {
          if (this.rows[i][field] !== '' && this.rows[i][field] !== undefined) {
            sampleRows.push({ lineNum: this.rows[i].__lineNum, value: this.rows[i][field] });
          }
        }

        result.push({
          field,
          inferredType: typeInfo.type,
          confidence: typeInfo.confidence,
          emptyRate: values.length > 0 ? (values.length - nonEmpty.length) / values.length : 0,
          uniqueCount: new Set(nonEmpty.map(v => String(v))).size,
          sampleValues: sampleRows,
          extra: typeInfo.type === 'enum' ? { enumValues: typeInfo.values } :
                 typeInfo.type === 'date' ? { format: typeInfo.format } :
                 typeInfo.type === 'integer' || typeInfo.type === 'number' ? {} :
                 { avgLength: typeInfo.avgLength }
        });
      }
    }
    return result;
  }

  _analyzeRuleDataConflicts(rules) {
    const conflicts = [];

    for (const [field, rule] of Object.entries(rules.fields || {})) {
      if (!this.columnData[field]) continue;

      const values = this.columnData[field];
      const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
      if (nonEmpty.length === 0) continue;

      if (rule.enum) {
        const outOfEnum = [];
        for (let i = 0; i < this.rows.length; i++) {
          const v = this.rows[i][field];
          if (v !== '' && v !== undefined && !rule.enum.includes(v)) {
            outOfEnum.push({ lineNum: this.rows[i].__lineNum, value: v });
          }
        }
        if (outOfEnum.length > 0) {
          conflicts.push({
            field,
            type: 'enum_out_of_range',
            description: `${outOfEnum.length} 条数据不在规则枚举列表中`,
            violationCount: outOfEnum.length,
            sampleRows: outOfEnum.slice(0, 5),
            ruleEnum: rule.enum
          });
        }
      }

      if (rule.type === 'integer' || rule.type === 'number') {
        if (rule.range) {
          const outOfRange = [];
          for (let i = 0; i < this.rows.length; i++) {
            const v = this.rows[i][field];
            if (v === '' || v === undefined) continue;
            const num = parseFloat(v);
            if (isNaN(num)) continue;
            if ((rule.range.min !== undefined && num < rule.range.min) ||
                (rule.range.max !== undefined && num > rule.range.max)) {
              outOfRange.push({ lineNum: this.rows[i].__lineNum, value: v });
            }
          }
          if (outOfRange.length > 0) {
            conflicts.push({
              field,
              type: 'range_violation',
              description: `${outOfRange.length} 条数据超出规则范围 [${rule.range.min}, ${rule.range.max}]`,
              violationCount: outOfRange.length,
              sampleRows: outOfRange.slice(0, 5),
              ruleRange: rule.range
            });
          }
        }
      }

      if (rule.type === 'date') {
        const invalidDates = [];
        for (let i = 0; i < this.rows.length; i++) {
          const v = this.rows[i][field];
          if (v === '' || v === undefined) continue;
          if (RuleEngine.parseDateToMs(v) === null) {
            invalidDates.push({ lineNum: this.rows[i].__lineNum, value: v });
          }
        }
        if (invalidDates.length > 0) {
          conflicts.push({
            field,
            type: 'invalid_date',
            description: `${invalidDates.length} 条数据无法解析为日期`,
            violationCount: invalidDates.length,
            sampleRows: invalidDates.slice(0, 5)
          });
        }
      }

      if (rule.pattern) {
        try {
          const regex = new RegExp(rule.pattern);
          const mismatches = [];
          for (let i = 0; i < this.rows.length; i++) {
            const v = this.rows[i][field];
            if (v === '' || v === undefined) continue;
            if (!regex.test(String(v))) {
              mismatches.push({ lineNum: this.rows[i].__lineNum, value: v });
            }
          }
          if (mismatches.length > 0) {
            conflicts.push({
              field,
              type: 'pattern_mismatch',
              description: `${mismatches.length} 条数据不匹配正则 ${rule.pattern}`,
              violationCount: mismatches.length,
              sampleRows: mismatches.slice(0, 5),
              rulePattern: rule.pattern
            });
          }
        } catch (e) {
          conflicts.push({
            field,
            type: 'invalid_pattern',
            description: `规则正则表达式无效: ${e.message}`,
            violationCount: 0,
            sampleRows: []
          });
        }
      }
    }

    return conflicts;
  }

  _discoverEnumCandidates(rules) {
    const candidates = [];

    for (const field of this.header) {
      const rule = rules.fields?.[field];
      const values = this.columnData[field];
      const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
      if (nonEmpty.length < 10) continue;

      const uniqueValues = new Map();
      for (let i = 0; i < this.rows.length; i++) {
        const v = this.rows[i][field];
        if (v === '' || v === undefined) continue;
        const key = String(v).trim().toLowerCase();
        if (!uniqueValues.has(key)) {
          uniqueValues.set(key, { value: v, count: 0, firstLine: this.rows[i].__lineNum });
        }
        uniqueValues.get(key).count++;
      }

      const uniqueCount = uniqueValues.size;
      const uniqueRatio = uniqueCount / nonEmpty.length;

      let shouldSuggest = false;
      let confidence = 0;
      let reason = '';

      if (uniqueRatio < 0.02 && uniqueCount <= 30) {
        shouldSuggest = true;
        confidence = 0.95;
        reason = `唯一值比例 ${(uniqueRatio * 100).toFixed(1)}% (${uniqueCount}/${nonEmpty.length})，极低离散度`;
      } else if (uniqueRatio < 0.05 && uniqueCount <= 50) {
        shouldSuggest = true;
        confidence = 0.8;
        reason = `唯一值比例 ${(uniqueRatio * 100).toFixed(1)}% (${uniqueCount}/${nonEmpty.length})，低离散度`;
      } else if (uniqueRatio < 0.1 && uniqueCount <= 20 && !rule?.enum) {
        shouldSuggest = true;
        confidence = 0.6;
        reason = `唯一值比例 ${(uniqueRatio * 100).toFixed(1)}%，可考虑枚举`;
      }

      if (shouldSuggest && !rule?.enum) {
        const sorted = Array.from(uniqueValues.values()).sort((a, b) => b.count - a.count);
        const topValues = sorted.slice(0, 30).map(item => item.value);
        const sampleRows = sorted.slice(0, 3).map(item => ({
          lineNum: item.firstLine,
          value: item.value,
          count: item.count
        }));

        candidates.push({
          field,
          confidence,
          reason,
          uniqueCount,
          totalNonEmpty: nonEmpty.length,
          uniqueRatio,
          candidateValues: topValues,
          valueDistribution: sorted.slice(0, 10).map(s => ({ value: s.value, count: s.count })),
          sampleRows
        });
      }
    }

    return candidates;
  }

  _analyzeDateFormats(rules) {
    const issues = [];

    for (const field of this.header) {
      const values = this.columnData[field];
      const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
      if (nonEmpty.length === 0) continue;

      const formats = {};
      const dateCount = [];
      for (let i = 0; i < this.rows.length; i++) {
        const v = this.rows[i][field];
        if (v === '' || v === undefined) continue;
        let matched = false;
        for (const p of DATE_PATTERNS) {
          if (p.regex.test(String(v).trim())) {
            if (!formats[p.format]) formats[p.format] = [];
            formats[p.format].push({ lineNum: this.rows[i].__lineNum, value: v });
            dateCount.push(v);
            matched = true;
            break;
          }
        }
        if (!matched) {
          const s = String(v).trim();
          const looksLikeTimestamp = /^\d{10}$/.test(s) || /^\d{13}$/.test(s);
          if (looksLikeTimestamp && RuleEngine.parseDateToMs(v) !== null) {
            if (!formats['other']) formats['other'] = [];
            formats['other'].push({ lineNum: this.rows[i].__lineNum, value: v });
            dateCount.push(v);
          }
        }
      }

      const dateRatio = dateCount.length / nonEmpty.length;
      const rule = rules.fields?.[field];
      if (dateRatio > 0.7 && Object.keys(formats).length > 1) {
        const currentFormat = rule?.dateFormat;
        const formatEntries = Object.entries(formats)
          .sort((a, b) => b[1].length - a[1].length);
        const dominantFormat = formatEntries[0];
        const dominantRatio = dominantFormat[1].length / dateCount.length;

        const sampleRows = [];
        for (let i = 1; i < formatEntries.length && sampleRows.length < 5; i++) {
          sampleRows.push(...formatEntries[i][1].slice(0, 2));
        }

        issues.push({
          field,
          isDateField: rule?.type === 'date',
          currentFormat: currentFormat || '(未设置)',
          detectedFormats: formatEntries.map(([fmt, rows]) => ({
            format: fmt,
            count: rows.length,
            ratio: rows.length / dateCount.length
          })),
          dominantFormat: dominantFormat[0],
          dominantRatio,
          mixedCount: Object.keys(formats).length,
          suggestion: dominantRatio > 0.8 ? `建议统一为 ${dominantFormat[0]}` : `存在 ${Object.keys(formats).length} 种日期格式，建议规范化`,
          sampleRows: sampleRows.slice(0, 5)
        });
      } else if (dateRatio > 0.8 && rule?.type !== 'date') {
        const formatEntries = Object.entries(formats)
          .sort((a, b) => b[1].length - a[1].length);
        issues.push({
          field,
          isDateField: false,
          currentFormat: '(非日期字段)',
          detectedFormats: formatEntries.map(([fmt, rows]) => ({
            format: fmt,
            count: rows.length,
            ratio: rows.length / dateCount.length
          })),
          dominantFormat: formatEntries[0]?.[0] || 'unknown',
          dominantRatio: formatEntries[0] ? formatEntries[0][1].length / dateCount.length : 0,
          mixedCount: Object.keys(formats).length,
          suggestion: `数据中 ${(dateRatio * 100).toFixed(0)}% 为日期格式，建议字段类型设为 date`,
          sampleRows: formatEntries[0]?.[1].slice(0, 3) || []
        });
      }
    }

    return issues;
  }

  _analyzeUniqueKeyRisks(rules) {
    const risks = [];
    const existingKeys = new Set();

    for (const uk of (rules.global?.uniqueKeys || [])) {
      const keyFields = Array.isArray(uk) ? uk : [uk];
      existingKeys.add(keyFields.sort().join('+'));
    }

    const singleFieldCandidates = [];
    for (const field of this.header) {
      const values = this.columnData[field];
      const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
      if (nonEmpty.length < 5) continue;

      const valueLines = new Map();
      let duplicates = 0;
      const dupSamples = [];
      for (let i = 0; i < this.rows.length; i++) {
        const v = this.rows[i][field];
        if (v === '' || v === undefined) continue;
        const key = String(v);
        if (valueLines.has(key)) {
          duplicates++;
          if (dupSamples.length < 3) {
            dupSamples.push({
              value: v,
              firstLine: valueLines.get(key),
              duplicateLine: this.rows[i].__lineNum
            });
          }
        } else {
          valueLines.set(key, this.rows[i].__lineNum);
        }
      }

      const uniqueCount = valueLines.size;
      const uniqueRatio = uniqueCount / nonEmpty.length;
      const isInRule = existingKeys.has(field);

      if (uniqueRatio > 0.95 && !isInRule && duplicates <= nonEmpty.length * 0.02) {
        singleFieldCandidates.push({
          field,
          uniqueRatio,
          uniqueCount,
          totalCount: nonEmpty.length,
          duplicates,
          duplicateRatio: duplicates / Math.max(1, nonEmpty.length),
          confidence: uniqueRatio > 0.99 ? 0.95 : uniqueRatio > 0.97 ? 0.85 : 0.7,
          sampleDuplicates: dupSamples
        });
      }

      if (isInRule && duplicates > 0) {
        risks.push({
          type: 'existing_unique_key_duplicates',
          keyFields: [field],
          duplicates,
          description: `现有唯一键 ${field} 存在 ${duplicates} 条重复`,
          sampleDuplicates: dupSamples
        });
      }
    }

    for (const cand of singleFieldCandidates) {
      risks.push({
        type: 'unique_key_candidate',
        keyFields: [cand.field],
        confidence: cand.confidence,
        uniqueRatio: cand.uniqueRatio,
        duplicates: cand.duplicates,
        description: `字段 ${cand.field} 唯一值比例 ${(cand.uniqueRatio * 100).toFixed(1)}%，可考虑设为唯一键`,
        sampleDuplicates: cand.sampleDuplicates
      });
    }

    return risks;
  }

  _analyzeCrossFieldRules(rules) {
    const results = [];
    const crossRules = rules.crossField || [];

    if (crossRules.length === 0) {
      const datePairs = this._discoverDatePairs();
      const numCorrelations = this._discoverNumericCorrelations();

      for (const pair of datePairs) {
        results.push({
          type: 'suggested_cross_field',
          ruleType: 'compare',
          left: pair.earlierField,
          operator: '<=',
          right: pair.laterField,
          dataType: 'date',
          description: `建议: ${pair.earlierField} 应早于或等于 ${pair.laterField}`,
          confidence: pair.confidence,
          violationCount: pair.violations,
          sampleRows: pair.sampleRows,
          suggestedYaml: {
            type: 'compare',
            left: pair.earlierField,
            operator: '<=',
            right: pair.laterField,
            dataType: 'date',
            description: `${pair.earlierField} 应早于或等于 ${pair.laterField}`
          }
        });
      }

      for (const corr of numCorrelations) {
        results.push({
          type: 'suggested_cross_field',
          ruleType: 'expression',
          description: `建议: ${corr.description}`,
          confidence: corr.confidence,
          violationCount: corr.violations,
          sampleRows: corr.sampleRows,
          suggestedYaml: corr.suggestedYaml
        });
      }
    } else {
      for (let rIdx = 0; rIdx < crossRules.length; rIdx++) {
        const rule = crossRules[rIdx];
        this.ruleEngine.reset();
        let hitCount = 0;
        const hitSamples = [];

        for (let i = 0; i < this.rows.length; i++) {
          const row = this.rows[i];
          const result = this.ruleEngine._validateCrossField(row, rule);
          if (result) {
            hitCount++;
            if (hitSamples.length < 5) {
              hitSamples.push({
                lineNum: row.__lineNum,
                severity: result.severity,
                message: result.message,
                rowData: this._extractRelevantFields(row, rule)
              });
            }
          }
        }

        results.push({
          type: 'existing_cross_field',
          ruleIndex: rIdx,
          rule,
          hitCount,
          hitRate: this.rows.length > 0 ? hitCount / this.rows.length : 0,
          sampleRows: hitSamples
        });
      }
    }

    return results;
  }

  _extractRelevantFields(row, rule) {
    const relevant = {};
    if (rule.left) relevant[rule.left] = row[rule.left];
    if (rule.right) relevant[rule.right] = row[rule.right];
    return relevant;
  }

  _discoverDatePairs() {
    const dateFields = [];
    for (const field of this.header) {
      const values = this.columnData[field];
      const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
      if (nonEmpty.length < 5) continue;
      let dateCount = 0;
      for (const v of nonEmpty) {
        if (RuleEngine.parseDateToMs(v) !== null) dateCount++;
      }
      if (dateCount / nonEmpty.length > 0.7) {
        dateFields.push(field);
      }
    }

    const pairs = [];
    for (let i = 0; i < dateFields.length; i++) {
      for (let j = i + 1; j < dateFields.length; j++) {
        const f1 = dateFields[i];
        const f2 = dateFields[j];
        let validPairs = 0;
        let f1Earlier = 0;
        let f2Earlier = 0;
        const violations = [];

        for (let k = 0; k < this.rows.length; k++) {
          const v1 = this.rows[k][f1];
          const v2 = this.rows[k][f2];
          const ms1 = RuleEngine.parseDateToMs(v1);
          const ms2 = RuleEngine.parseDateToMs(v2);
          if (ms1 === null || ms2 === null) continue;
          validPairs++;
          if (ms1 <= ms2) f1Earlier++;
          else {
            f2Earlier++;
            if (violations.length < 3) {
              violations.push({
                lineNum: this.rows[k].__lineNum,
                [f1]: v1,
                [f2]: v2
              });
            }
          }
        }

        if (validPairs >= 10) {
          const earlierField = f1Earlier >= f2Earlier ? f1 : f2;
          const laterField = f1Earlier >= f2Earlier ? f2 : f1;
          const passRate = Math.max(f1Earlier, f2Earlier) / validPairs;
          const violationCount = Math.min(f1Earlier, f2Earlier);

          if (passRate >= 0.8) {
            pairs.push({
              earlierField,
              laterField,
              passRate,
              violations: violationCount,
              confidence: passRate > 0.95 ? 0.95 : passRate > 0.9 ? 0.85 : 0.7,
              sampleRows: violations
            });
          }
        }
      }
    }
    return pairs;
  }

  _discoverNumericCorrelations() {
    const correlations = [];
    const numFields = [];

    for (const field of this.header) {
      const values = this.columnData[field];
      const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
      if (nonEmpty.length < 10) continue;
      let numCount = 0;
      for (const v of nonEmpty) {
        if (!isNaN(parseFloat(v)) && isFinite(v)) numCount++;
      }
      if (numCount / nonEmpty.length > 0.9) {
        numFields.push(field);
      }
    }

    for (let i = 0; i < numFields.length; i++) {
      for (let j = i + 1; j < numFields.length; j++) {
        for (let k = j + 1; k < numFields.length; k++) {
          const a = numFields[i], b = numFields[j], c = numFields[k];
          let valid = 0;
          let matchProduct = 0;
          let matchSum = 0;
          const prodSamples = [];
          const sumSamples = [];

          for (let r = 0; r < this.rows.length; r++) {
            const va = parseFloat(this.rows[r][a]);
            const vb = parseFloat(this.rows[r][b]);
            const vc = parseFloat(this.rows[r][c]);
            if (isNaN(va) || isNaN(vb) || isNaN(vc)) continue;
            valid++;

            const product = va * vb;
            if (Math.abs(product - vc) < 0.01 || Math.abs(vc) < 0.01 && Math.abs(product) < 0.01) {
              matchProduct++;
            } else if (prodSamples.length < 3) {
              prodSamples.push({ lineNum: this.rows[r].__lineNum, [a]: va, [b]: vb, [c]: vc, expected: product });
            }

            const sum = va + vb;
            if (Math.abs(sum - vc) < 0.01) {
              matchSum++;
            } else if (sumSamples.length < 3) {
              sumSamples.push({ lineNum: this.rows[r].__lineNum, [a]: va, [b]: vb, [c]: vc, expected: sum });
            }
          }

          if (valid >= 10) {
            if (matchProduct / valid >= 0.7) {
              correlations.push({
                description: `${c} ≈ ${a} × ${b}`,
                confidence: matchProduct / valid > 0.9 ? 0.9 : 0.75,
                violations: valid - matchProduct,
                sampleRows: prodSamples,
                suggestedYaml: {
                  type: 'expression',
                  expression: `Math.abs(parseFloat(row.${c}) - parseFloat(row.${a}) * parseFloat(row.${b})) < 0.01 || row.${c} === ''`,
                  description: `${c} 应等于 ${a} 乘以 ${b}`
                }
              });
            }
            if (matchSum / valid >= 0.7) {
              correlations.push({
                description: `${c} ≈ ${a} + ${b}`,
                confidence: matchSum / valid > 0.9 ? 0.9 : 0.75,
                violations: valid - matchSum,
                sampleRows: sumSamples,
                suggestedYaml: {
                  type: 'expression',
                  expression: `Math.abs(parseFloat(row.${c}) - parseFloat(row.${a}) - parseFloat(row.${b})) < 0.01 || row.${c} === ''`,
                  description: `${c} 应等于 ${a} 加 ${b}`
                }
              });
            }
          }
        }
      }
    }
    return correlations;
  }

  _generateSuggestions(report) {
    const suggestions = [];
    const confidenceLabel = (c) => c >= 0.9 ? 'high' : c >= 0.7 ? 'medium' : 'low';

    for (const field of report.unconstrainedFields) {
      let ruleSnippet = {};
      if (field.inferredType === 'date') {
        ruleSnippet = {
          [field.field]: {
            required: field.emptyRate < 0.1,
            type: 'date',
            dateFormat: 'YYYY-MM-DD'
          }
        };
      } else if (field.inferredType === 'integer') {
        ruleSnippet = {
          [field.field]: {
            required: field.emptyRate < 0.1,
            type: 'integer'
          }
        };
      } else if (field.inferredType === 'number') {
        ruleSnippet = {
          [field.field]: {
            required: field.emptyRate < 0.1,
            type: 'number'
          }
        };
      } else if (field.inferredType === 'enum' && field.extra?.enumValues) {
        ruleSnippet = {
          [field.field]: {
            required: field.emptyRate < 0.1,
            type: 'enum',
            enum: field.extra.enumValues
          }
        };
      } else {
        ruleSnippet = {
          [field.field]: {
            required: field.emptyRate < 0.1,
            type: 'string',
            trim: true
          }
        };
      }

      suggestions.push({
        id: `unconstrained-${field.field}`,
        category: 'unconstrained_field',
        title: `为字段 ${field.field} 添加规则`,
        description: `字段 ${field.field} 当前无规则约束，推断类型为 ${field.inferredType}（置信度 ${(field.confidence * 100).toFixed(0)}%）`,
        confidence: field.confidence,
        confidenceLabel: confidenceLabel(field.confidence),
        evidence: {
          sampleRows: field.sampleValues,
          inferredType: field.inferredType,
          emptyRate: field.emptyRate
        },
        yamlSnippet: yaml.stringify({ fields: ruleSnippet }).trim()
      });
    }

    for (const cand of report.enumCandidates) {
      const ruleSnippet = {
        [cand.field]: {
          type: 'enum',
          enum: cand.candidateValues
        }
      };
      suggestions.push({
        id: `enum-${cand.field}`,
        category: 'enum_candidate',
        title: `为字段 ${cand.field} 添加枚举约束`,
        description: cand.reason,
        confidence: cand.confidence,
        confidenceLabel: confidenceLabel(cand.confidence),
        evidence: {
          sampleRows: cand.sampleRows,
          uniqueCount: cand.uniqueCount,
          valueDistribution: cand.valueDistribution
        },
        yamlSnippet: yaml.stringify({ fields: ruleSnippet }).trim()
      });
    }

    for (const df of report.dateFormatIssues) {
      if (!df.isDateField) {
        const ruleSnippet = {
          [df.field]: {
            type: 'date',
            dateFormat: df.dominantFormat && df.dominantFormat.includes('YYYY') && df.dominantFormat.includes('MM') && df.dominantFormat.includes('DD') && !df.dominantFormat.includes('timestamp')
              ? 'YYYY-MM-DD'
              : (df.dominantFormat || 'YYYY-MM-DD').replace(/年M月D日/, 'YYYY-MM-DD').replace(/\//g, '-').replace(/\./g, '-')
          }
        };
        suggestions.push({
          id: `date-type-${df.field}`,
          category: 'date_field_suggestion',
          title: `将字段 ${df.field} 标记为日期类型`,
          description: df.suggestion,
          confidence: 0.85,
          confidenceLabel: 'high',
          evidence: {
            sampleRows: df.sampleRows,
            detectedFormats: df.detectedFormats
          },
          yamlSnippet: yaml.stringify({ fields: ruleSnippet }).trim()
        });
      } else if (df.mixedCount > 1) {
        const targetFormat = 'YYYY-MM-DD';
        const ruleSnippet = {
          [df.field]: {
            type: 'date',
            dateFormat: targetFormat
          }
        };
        suggestions.push({
          id: `date-format-${df.field}`,
          category: 'date_format_mixed',
          title: `统一字段 ${df.field} 的日期格式`,
          description: `检测到 ${df.mixedCount} 种日期格式，建议统一为 ${targetFormat}（配合清洗工具自动转换）`,
          confidence: 0.9,
          confidenceLabel: 'high',
          evidence: {
            sampleRows: df.sampleRows,
            detectedFormats: df.detectedFormats
          },
          yamlSnippet: yaml.stringify({ fields: ruleSnippet }).trim()
        });
      }
    }

    for (const risk of report.uniqueKeyRisks) {
      if (risk.type === 'unique_key_candidate') {
        const keyField = risk.keyFields[0];
        const ruleSnippet = {
          global: {
            uniqueKeys: [keyField]
          }
        };
        suggestions.push({
          id: `uk-candidate-${keyField}`,
          category: 'unique_key_candidate',
          title: `将 ${keyField} 设为唯一键`,
          description: risk.description,
          confidence: risk.confidence,
          confidenceLabel: confidenceLabel(risk.confidence),
          evidence: {
            sampleRows: risk.sampleDuplicates,
            uniqueRatio: risk.uniqueRatio
          },
          yamlSnippet: yaml.stringify(ruleSnippet).trim()
        });
      }
    }

    for (const cf of report.crossFieldRuleHits) {
      if (cf.type === 'suggested_cross_field') {
        suggestions.push({
          id: `cross-field-suggestion-${cf.left || cf.ruleIndex}-${cf.right || ''}`,
          category: 'cross_field_suggestion',
          title: `添加跨字段规则: ${cf.description}`,
          description: `检测到潜在跨字段约束关系，违反样例 ${cf.violationCount} 条`,
          confidence: cf.confidence,
          confidenceLabel: confidenceLabel(cf.confidence),
          evidence: {
            sampleRows: cf.sampleRows,
            violationCount: cf.violationCount
          },
          yamlSnippet: yaml.stringify({ crossField: [cf.suggestedYaml] }).trim()
        });
      }
    }

    for (const conflict of report.ruleDataConflicts) {
      if (conflict.type === 'enum_out_of_range') {
        const allValues = new Set([...conflict.ruleEnum]);
        for (const s of conflict.sampleRows) {
          allValues.add(s.value);
        }
        const ruleSnippet = {
          [conflict.field]: {
            type: 'enum',
            enum: Array.from(allValues)
          }
        };
        suggestions.push({
          id: `conflict-enum-${conflict.field}`,
          category: 'rule_conflict',
          title: `扩展字段 ${conflict.field} 的枚举列表`,
          description: conflict.description,
          confidence: 0.6,
          confidenceLabel: 'medium',
          evidence: {
            sampleRows: conflict.sampleRows,
            originalEnum: conflict.ruleEnum
          },
          yamlSnippet: yaml.stringify({ fields: ruleSnippet }).trim()
        });
      }
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  _generateMarkdownReport(report) {
    const lines = [];
    const fmtPct = (n) => (n * 100).toFixed(1) + '%';
    const fmtConf = (c) => c >= 0.9 ? '🔴 高' : c >= 0.7 ? '🟡 中' : '🔵 低';

    lines.push('# CSV 规则审计报告\n');
    lines.push(`> 生成时间: ${new Date().toLocaleString('zh-CN')}\n`);

    lines.push('## 📁 审计源信息\n');
    lines.push('| 项目 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| CSV 文件 | \`${report.source.csvFile}\` |`);
    lines.push(`| 规则文件 | \`${report.source.rulesFile}\` |`);
    lines.push(`| 数据行数 | ${report.source.totalRows} |`);
    lines.push(`| 字段数量 | ${report.source.totalColumns} |\n`);

    lines.push('## 📊 规则覆盖率\n');
    lines.push('| 指标 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| 总字段数 | ${report.coverage.totalFields} |`);
    lines.push(`| 已覆盖字段 | ${report.coverage.coveredFields} |`);
    lines.push(`| 未覆盖字段 | ${report.coverage.uncoveredFields} |`);
    lines.push(`| 覆盖率 | **${fmtPct(report.coverage.coverageRate)}** |`);
    lines.push(`| 全局唯一键 | ${report.coverage.hasGlobalUniqueKeys ? '✅ 已配置' : '⚠️ 未配置'} |`);
    lines.push(`| 跨字段规则 | ${report.coverage.hasCrossFieldRules ? '✅ 已配置' : '⚠️ 未配置'} |\n`);

    if (report.coverage.uncoveredFields.length > 0) {
      lines.push('### 🔍 未被规则约束的字段\n');
      lines.push('| 字段 | 推断类型 | 置信度 | 空值率 | 唯一值数 | 样例行 |');
      lines.push('|------|----------|--------|--------|----------|--------|');
      for (const f of report.unconstrainedFields) {
        const samples = f.sampleValues.map(s => `行${s.lineNum}: "${s.value}"`).join('<br>');
        lines.push(`| \`${f.field}\` | ${f.inferredType} | ${fmtPct(f.confidence)} | ${fmtPct(f.emptyRate)} | ${f.uniqueCount} | ${samples || '-'} |`);
      }
      lines.push('');
    }

    if (report.ruleDataConflicts.length > 0) {
      lines.push('## ⚠️ 规则与数据冲突\n');
      lines.push('| 字段 | 冲突类型 | 违反数 | 描述 | 样例行 |');
      lines.push('|------|----------|--------|------|--------|');
      for (const c of report.ruleDataConflicts) {
        const samples = c.sampleRows.map(s => `行${s.lineNum}: "${s.value}"`).join('<br>');
        lines.push(`| \`${c.field}\` | ${c.type} | ${c.violationCount} | ${c.description} | ${samples || '-'} |`);
      }
      lines.push('');
    }

    if (report.enumCandidates.length > 0) {
      lines.push('## 🎯 枚举值候选发现\n');
      lines.push('| 字段 | 置信度 | 唯一值数/总数 | 原因 | 候选值(Top) |');
      lines.push('|------|--------|---------------|------|-------------|');
      for (const e of report.enumCandidates) {
        const topVals = e.valueDistribution.slice(0, 5).map(v => `\`${v.value}\`(${v.count})`).join(', ');
        lines.push(`| \`${e.field}\` | ${fmtConf(e.confidence)} ${(e.confidence * 100).toFixed(0)}% | ${e.uniqueCount}/${e.totalNonEmpty} | ${e.reason} | ${topVals} |`);
      }
      lines.push('');
    }

    if (report.dateFormatIssues.length > 0) {
      lines.push('## 📅 日期格式分析\n');
      lines.push('| 字段 | 当前配置 | 格式数 | 主导格式 | 主导占比 | 建议 |');
      lines.push('|------|----------|--------|----------|----------|------|');
      for (const d of report.dateFormatIssues) {
        lines.push(`| \`${d.field}\` | ${d.currentFormat} | ${d.mixedCount} | ${d.dominantFormat} | ${fmtPct(d.dominantRatio)} | ${d.suggestion} |`);
      }
      lines.push('');
    }

    if (report.uniqueKeyRisks.length > 0) {
      lines.push('## 🔑 唯一键风险与候选\n');
      lines.push('| 类型 | 字段 | 描述 | 置信度 | 重复样例 |');
      lines.push('|------|------|------|--------|----------|');
      for (const r of report.uniqueKeyRisks) {
        const dups = (r.sampleDuplicates || []).map(d =>
          d.firstLine !== undefined ? `值"${d.value}"行${d.firstLine}与行${d.duplicateLine}` : `${d}`
        ).join('<br>');
        const conf = r.confidence !== undefined ? `${fmtConf(r.confidence)} ${(r.confidence * 100).toFixed(0)}%` : '-';
        lines.push(`| ${r.type} | \`${r.keyFields.join('+')}\` | ${r.description} | ${conf} | ${dups || '-'} |`);
      }
      lines.push('');
    }

    if (report.crossFieldRuleHits.length > 0) {
      lines.push('## 🔗 跨字段规则命中/建议\n');
      lines.push('| 类型 | 规则描述 | 命中/违反数 | 置信度 |');
      lines.push('|------|----------|-------------|--------|');
      for (const cf of report.crossFieldRuleHits) {
        const desc = cf.rule ? (cf.rule.description || `${cf.rule.left} ${cf.rule.operator} ${cf.rule.right}`) : cf.description;
        const count = cf.hitCount !== undefined ? cf.hitCount : (cf.violationCount !== undefined ? cf.violationCount : '-');
        const conf = cf.confidence !== undefined ? `${fmtConf(cf.confidence)} ${(cf.confidence * 100).toFixed(0)}%` : '-';
        lines.push(`| ${cf.type} | ${desc} | ${count} | ${conf} |`);
      }
      lines.push('');
    }

    if (report.suggestions.length > 0) {
      lines.push('## 💡 规则修复建议\n');
      for (let i = 0; i < report.suggestions.length; i++) {
        const s = report.suggestions[i];
        lines.push(`### ${i + 1}. [${s.confidenceLabel.toUpperCase()}] ${s.title}\n`);
        lines.push(`**描述**: ${s.description}\n`);
        lines.push(`**置信度**: ${fmtConf(s.confidence)} ${(s.confidence * 100).toFixed(0)}%\n`);

        if (s.evidence?.sampleRows && s.evidence.sampleRows.length > 0) {
          lines.push('**依据样例行**:\n');
          for (const sr of s.evidence.sampleRows) {
            const parts = [];
            if (sr.lineNum) parts.push(`行${sr.lineNum}`);
            if (sr.value !== undefined) parts.push(`值="${sr.value}"`);
            if (sr.count !== undefined) parts.push(`出现${sr.count}次`);
            if (sr.firstLine !== undefined) parts.push(`首次行${sr.firstLine},重复行${sr.duplicateLine}`);
            lines.push(`- ${parts.join(', ')}`);
          }
          lines.push('');
        }

        lines.push('**可合并 YAML 片段**:\n');
        lines.push('```yaml');
        lines.push(s.yamlSnippet);
        lines.push('```\n');
      }
    }

    return lines.join('\n');
  }

  static writeJsonReport(report, outputPath) {
    const data = {
      source: report.source,
      coverage: report.coverage,
      unconstrainedFields: report.unconstrainedFields,
      ruleDataConflicts: report.ruleDataConflicts,
      enumCandidates: report.enumCandidates,
      dateFormatIssues: report.dateFormatIssues,
      uniqueKeyRisks: report.uniqueKeyRisks,
      crossFieldRuleHits: report.crossFieldRuleHits,
      suggestions: report.suggestions
    };
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');
    return outputPath;
  }

  static writeMarkdownReport(report, outputPath) {
    fs.writeFileSync(outputPath, report.markdown, 'utf-8');
    return outputPath;
  }
}

module.exports = RuleAuditor;
