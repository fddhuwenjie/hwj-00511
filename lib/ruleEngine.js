const fs = require('fs');
const yaml = require('yaml');
const path = require('path');

class RuleEngine {
  constructor() {
    this.rules = null;
    this.uniqueKeyState = new Map();
    this.uniqueKeyViolations = [];
  }

  load(yamlPath) {
    const content = fs.readFileSync(yamlPath, 'utf-8');
    this.rules = yaml.parse(content);
    if (!this.rules) this.rules = {};
    if (!this.rules.fields) this.rules.fields = {};
    if (!this.rules.crossField) this.rules.crossField = [];
    if (!this.rules.global) this.rules.global = {};
    this.uniqueKeyState = new Map();
    this.uniqueKeyViolations = [];
    return this.rules;
  }

  reset() {
    this.uniqueKeyState = new Map();
    this.uniqueKeyViolations = [];
  }

  static parseDateToMs(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    if (s === '') return null;

    if (/^\d{13}$/.test(s)) {
      const ms = parseInt(s);
      return isNaN(ms) ? null : ms;
    }
    if (/^\d{10}$/.test(s)) {
      const ms = parseInt(s) * 1000;
      return isNaN(ms) ? null : ms;
    }

    const cnMatch = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (cnMatch) {
      const [, y, mo, d, h = 0, mi = 0, se = 0] = cnMatch;
      const dt = new Date(parseInt(y), parseInt(mo) - 1, parseInt(d), parseInt(h), parseInt(mi), parseInt(se));
      return isNaN(dt.getTime()) ? null : dt.getTime();
    }

    const cnShortMatch = s.match(/^(\d{4})年(\d{1,2})月$/);
    if (cnShortMatch) {
      const [, y, mo] = cnShortMatch;
      const dt = new Date(parseInt(y), parseInt(mo) - 1, 1);
      return isNaN(dt.getTime()) ? null : dt.getTime();
    }

    const normalized = s.replace(/\./g, '-').replace(/\//g, '-');
    const isoMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (isoMatch) {
      const [, y, mo, d, h = 0, mi = 0, se = 0] = isoMatch;
      const dt = new Date(parseInt(y), parseInt(mo) - 1, parseInt(d), parseInt(h), parseInt(mi), parseInt(se));
      return isNaN(dt.getTime()) ? null : dt.getTime();
    }

    const ddMmYyyy = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (ddMmYyyy) {
      const [, d, mo, y, h = 0, mi = 0, se = 0] = ddMmYyyy;
      const dt = new Date(parseInt(y), parseInt(mo) - 1, parseInt(d), parseInt(h), parseInt(mi), parseInt(se));
      return isNaN(dt.getTime()) ? null : dt.getTime();
    }

    const fallback = new Date(s);
    return isNaN(fallback.getTime()) ? null : fallback.getTime();
  }

  validateRow(row, lineNum, rowIndex, profile) {
    const issues = [];
    const warnings = [];

    for (const [field, rule] of Object.entries(this.rules.fields || {})) {
      const value = row[field];
      const fieldIssues = this._validateField(field, value, rule, row);
      for (const fi of fieldIssues) {
        if (fi.severity === 'warning') warnings.push({ ...fi, field, lineNum, rowIndex });
        else issues.push({ ...fi, field, lineNum, rowIndex });
      }
    }

    const uniqueKeyResult = this.checkUniqueKey(row, lineNum, rowIndex);
    for (const uk of uniqueKeyResult) {
      issues.push({ ...uk, lineNum, rowIndex });
    }

    for (const rule of this.rules.crossField || []) {
      const result = this._validateCrossField(row, rule);
      if (result) {
        if (result.severity === 'warning') warnings.push({ ...result, lineNum, rowIndex });
        else issues.push({ ...result, lineNum, rowIndex });
      }
    }

    return { issues, warnings };
  }

  checkUniqueKey(row, lineNum, rowIndex) {
    const uniqueKeysList = this.getUniqueKeys();
    if (uniqueKeysList.length === 0) return [];

    const violations = [];

    const isNested = Array.isArray(uniqueKeysList[0]);
    const keyGroups = isNested ? uniqueKeysList : [uniqueKeysList];

    for (const keyGroup of keyGroups) {
      const keyName = keyGroup.join('+');
      const values = keyGroup.map(k => row[k] !== undefined && row[k] !== null ? String(row[k]) : '');
      const allFilled = keyGroup.every(k => row[k] !== '' && row[k] !== null && row[k] !== undefined);
      const sig = values.join('\x00');

      if (!this.uniqueKeyState.has(keyName)) {
        this.uniqueKeyState.set(keyName, new Map());
      }
      const stateMap = this.uniqueKeyState.get(keyName);

      if (!allFilled) continue;

      if (stateMap.has(sig)) {
        const firstLine = stateMap.get(sig);
        this.uniqueKeyViolations.push({
          keyName,
          keyFields: keyGroup,
          keyValues: values,
          firstLine,
          duplicateLine: lineNum
        });
        violations.push({
          severity: 'error',
          type: 'unique_key',
          field: keyName,
          fields: keyGroup,
          keyValues: values,
          firstOccurrence: firstLine,
          message: `唯一键冲突 [${keyGroup.join(' + ')}] = [${values.join(', ')}]，首次出现在行${firstLine}`
        });
      } else {
        stateMap.set(sig, lineNum);
      }
    }

    return violations;
  }

  getAllUniqueKeyViolations() {
    return this.uniqueKeyViolations;
  }

  _validateField(field, value, rule, row) {
    const issues = [];
    const isEmpty = value === '' || value === null || value === undefined;

    if (rule.required && isEmpty) {
      issues.push({ severity: 'error', type: 'required', message: `字段 ${field} 必填但为空` });
      return issues;
    }
    if (isEmpty && !rule.required) return issues;

    if (rule.type && !this._checkType(value, rule.type)) {
      issues.push({ severity: 'error', type: 'type', message: `字段 ${field} 类型应为 ${rule.type}，实际值 "${value}"` });
    }

    if (rule.pattern) {
      const regex = new RegExp(rule.pattern);
      if (!regex.test(String(value))) {
        issues.push({ severity: 'error', type: 'pattern', message: `字段 ${field} 不匹配正则 ${rule.pattern}` });
      }
    }

    if (rule.enum && !rule.enum.includes(value)) {
      issues.push({ severity: 'error', type: 'enum', message: `字段 ${field} 值 "${value}" 不在允许列表中: [${rule.enum.join(', ')}]` });
    }

    if (rule.range !== undefined && (rule.type === 'integer' || rule.type === 'number')) {
      const num = parseFloat(value);
      if (rule.range.min !== undefined && num < rule.range.min) {
        issues.push({ severity: 'error', type: 'range', message: `字段 ${field} 值 ${value} 小于最小值 ${rule.range.min}` });
      }
      if (rule.range.max !== undefined && num > rule.range.max) {
        issues.push({ severity: 'error', type: 'range', message: `字段 ${field} 值 ${value} 大于最大值 ${rule.range.max}` });
      }
    }

    if (rule.minLength !== undefined && String(value).length < rule.minLength) {
      issues.push({ severity: 'warning', type: 'length', message: `字段 ${field} 长度 ${String(value).length} 小于最小长度 ${rule.minLength}` });
    }
    if (rule.maxLength !== undefined && String(value).length > rule.maxLength) {
      issues.push({ severity: 'warning', type: 'length', message: `字段 ${field} 长度 ${String(value).length} 大于最大长度 ${rule.maxLength}` });
    }

    return issues;
  }

  _checkType(value, type) {
    const s = String(value).trim();
    switch (type) {
      case 'integer': return /^-?\d+$/.test(s);
      case 'number': return !isNaN(parseFloat(s)) && isFinite(s);
      case 'boolean': return ['true', 'false', '是', '否', 'yes', 'no', '1', '0'].includes(s.toLowerCase());
      case 'date':
        return RuleEngine.parseDateToMs(s) !== null;
      case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
      case 'url': return /^https?:\/\/.+/.test(s);
      case 'string': return true;
      default: return true;
    }
  }

  _validateCrossField(row, rule) {
    if (rule.type === 'compare') {
      const left = row[rule.left];
      const right = row[rule.right];
      if (left === '' || left === undefined || left === null ||
          right === '' || right === undefined || right === null) return null;

      let cmp;
      let leftVal = left;
      let rightVal = right;

      if (rule.dataType === 'date') {
        const leftMs = RuleEngine.parseDateToMs(left);
        const rightMs = RuleEngine.parseDateToMs(right);
        if (leftMs === null || rightMs === null) {
          return {
            severity: 'warning',
            type: 'cross_field',
            message: `跨字段日期解析失败，无法比较: ${rule.left}=${left}, ${rule.right}=${right} ${rule.description || ''}`,
            fields: [rule.left, rule.right]
          };
        }
        cmp = leftMs - rightMs;
        const leftNorm = this._normalizeDate(left, 'YYYY-MM-DD');
        const rightNorm = this._normalizeDate(right, 'YYYY-MM-DD');
        if (leftNorm) leftVal = leftNorm;
        if (rightNorm) rightVal = rightNorm;
      } else if (rule.dataType === 'number') {
        const ln = parseFloat(left);
        const rn = parseFloat(right);
        if (isNaN(ln) || isNaN(rn)) {
          return {
            severity: 'warning',
            type: 'cross_field',
            message: `跨字段数字解析失败，无法比较: ${rule.left}=${left}, ${rule.right}=${right} ${rule.description || ''}`,
            fields: [rule.left, rule.right]
          };
        }
        cmp = ln - rn;
      } else {
        cmp = String(left).localeCompare(String(right));
      }

      let pass = false;
      let opText = '';
      switch (rule.operator) {
        case '>': pass = cmp > 0; opText = '>'; break;
        case '>=': pass = cmp >= 0; opText = '>='; break;
        case '<': pass = cmp < 0; opText = '<'; break;
        case '<=': pass = cmp <= 0; opText = '<='; break;
        case '==': pass = cmp === 0; opText = '=='; break;
        case '!=': pass = cmp !== 0; opText = '!='; break;
      }

      if (!pass) {
        return {
          severity: rule.severity || 'error',
          type: 'cross_field',
          message: `跨字段规则失败: ${rule.left} (${leftVal}) ${opText} ${rule.right} (${rightVal}) ${rule.description || ''}`,
          fields: [rule.left, rule.right]
        };
      }
    }

    if (rule.type === 'expression') {
      try {
        const fn = new Function('row', `return ${rule.expression}`);
        if (!fn(row)) {
          return {
            severity: rule.severity || 'error',
            type: 'cross_field',
            message: `表达式规则失败: ${rule.description || rule.expression}`
          };
        }
      } catch (e) {
        return { severity: 'warning', type: 'cross_field', message: `规则表达式错误: ${e.message}` };
      }
    }

    return null;
  }

  cleanField(field, value, rule) {
    if (value === null || value === undefined) value = '';
    let changed = false;
    let original = value;
    let newValue = String(value);

    if (rule.trim !== false && newValue !== newValue.trim()) {
      newValue = newValue.trim();
      changed = true;
    }

    if (rule.case === 'upper' && newValue !== newValue.toUpperCase()) {
      newValue = newValue.toUpperCase();
      changed = true;
    }
    if (rule.case === 'lower' && newValue !== newValue.toLowerCase()) {
      newValue = newValue.toLowerCase();
      changed = true;
    }
    if (rule.case === 'title') {
      const titled = newValue.replace(/\b\w/g, c => c.toUpperCase());
      if (newValue !== titled) { newValue = titled; changed = true; }
    }

    if (rule.enumMap && rule.enumMap[newValue] !== undefined && rule.enumMap[newValue] !== newValue) {
      newValue = rule.enumMap[newValue];
      changed = true;
    }

    if ((rule.type === 'date' || rule.dateFormat) && newValue) {
      const normalized = this._normalizeDate(newValue, rule.dateFormat || 'YYYY-MM-DD');
      if (normalized && normalized !== newValue) {
        newValue = normalized;
        changed = true;
      }
    }

    if ((rule.type === 'integer' || rule.type === 'number') && newValue) {
      const trimmed = newValue.trim();
      if (trimmed !== newValue) {
        newValue = trimmed;
        changed = true;
      }
    }

    if (newValue === '' && rule.fillValue !== undefined) {
      newValue = String(rule.fillValue);
      changed = true;
    }

    return { value: newValue, changed, original };
  }

  _normalizeDate(value, targetFormat) {
    const ms = RuleEngine.parseDateToMs(value);
    if (ms === null) return null;

    const parsed = new Date(ms);
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    const hh = String(parsed.getHours()).padStart(2, '0');
    const mm = String(parsed.getMinutes()).padStart(2, '0');
    const ss = String(parsed.getSeconds()).padStart(2, '0');

    return targetFormat
      .replace('YYYY', y)
      .replace('MM', m)
      .replace('DD', d)
      .replace('HH', hh)
      .replace('mm', mm)
      .replace('ss', ss);
  }

  getUniqueKeys() {
    return this.rules.global?.uniqueKeys || [];
  }

  getFieldRule(field) {
    return this.rules.fields?.[field] || {};
  }
}

module.exports = RuleEngine;
