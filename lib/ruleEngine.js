const fs = require('fs');
const yaml = require('yaml');
const path = require('path');

class RuleEngine {
  constructor() {
    this.rules = null;
  }

  load(yamlPath) {
    const content = fs.readFileSync(yamlPath, 'utf-8');
    this.rules = yaml.parse(content);
    if (!this.rules) this.rules = {};
    if (!this.rules.fields) this.rules.fields = {};
    if (!this.rules.crossField) this.rules.crossField = [];
    if (!this.rules.global) this.rules.global = {};
    return this.rules;
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

    for (const rule of this.rules.crossField || []) {
      const result = this._validateCrossField(row, rule);
      if (result) {
        if (result.severity === 'warning') warnings.push({ ...result, lineNum, rowIndex });
        else issues.push({ ...result, lineNum, rowIndex });
      }
    }

    return { issues, warnings };
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
        const { DATE_PATTERNS } = require('./qualityChecker');
        return DATE_PATTERNS.some(p => p.regex.test(s));
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
      if (left === '' || left === undefined || right === '' || right === undefined) return null;

      let cmp;
      if (rule.dataType === 'date') {
        cmp = new Date(left) - new Date(right);
      } else if (rule.dataType === 'number') {
        cmp = parseFloat(left) - parseFloat(right);
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
          message: `跨字段规则失败: ${rule.left} (${left}) ${opText} ${rule.right} (${right}) ${rule.description || ''}`,
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
    const s = String(value).trim();
    let parsed = null;

    if (/^\d{13}$/.test(s)) {
      parsed = new Date(parseInt(s));
    } else if (/^\d{10}$/.test(s)) {
      parsed = new Date(parseInt(s) * 1000);
    } else {
      const cnMatch = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (cnMatch) {
        parsed = new Date(parseInt(cnMatch[1]), parseInt(cnMatch[2]) - 1, parseInt(cnMatch[3]));
      } else {
        const normalized = s.replace(/\./g, '-').replace(/\//g, '-');
        parsed = new Date(normalized);
      }
    }

    if (!parsed || isNaN(parsed.getTime())) return null;

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
