const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const Table = require('cli-table3');

function formatPct(n) {
  return (n * 100).toFixed(1) + '%';
}

function formatNum(n) {
  if (typeof n !== 'number') return n;
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toPrecision(3);
}

function severityColor(sev) {
  switch (sev) {
    case 'high': return chalk.red;
    case 'medium': return chalk.yellow;
    case 'low': return chalk.blue;
    default: return chalk.white;
  }
}

function gradeColor(grade) {
  if (grade === 'A') return chalk.green;
  if (grade === 'B') return chalk.cyan;
  if (grade === 'C') return chalk.yellow;
  if (grade === 'D') return chalk.magenta;
  return chalk.red;
}

function printConsoleReport(report, options = {}) {
  console.log('\n' + chalk.bold('═══════════════════════════════════════════════════════'));
  console.log(chalk.bold('           CSV 数据质量检测报告'));
  console.log(chalk.bold('═══════════════════════════════════════════════════════\n'));

  console.log(chalk.bold('📁 文件信息'));
  console.log(`  文件:         ${report.file}`);
  console.log(`  编码:         ${report.detection.encoding}`);
  console.log(`  分隔符:       ${JSON.stringify(report.detection.delimiter)}`);
  console.log(`  行数:         ${report.rowCount}`);
  console.log(`  列数:         ${report.columnCount}`);
  console.log(`  重复行:       ${report.duplicateRows}`);
  console.log(`  总空值率:     ${formatPct(report.totalEmptyRate)}`);
  console.log('');

  console.log(chalk.bold('🎯 综合评分'));
  const scoreColor = report.score >= 80 ? chalk.green : report.score >= 60 ? chalk.yellow : chalk.red;
  console.log(`  分数:         ${scoreColor(report.score)} / 100`);
  console.log(`  等级:         ${gradeColor(report.grade).bold(report.grade)}`);
  console.log('');

  const colTable = new Table({
    head: [chalk.bold('列名'), chalk.bold('类型'), chalk.bold('置信度'), chalk.bold('空值率'), chalk.bold('唯一值'), chalk.bold('问题')],
    colWidths: [20, 10, 10, 10, 10, 30]
  });

  for (const col of report.header) {
    const c = report.columns[col];
    colTable.push([
      col,
      c.type,
      formatPct(c.confidence),
      formatPct(c.stats.emptyRate),
      String(c.stats.unique),
      c.issues.map(i => severityColor(i.severity)(i.message)).join('; ') || chalk.gray('无')
    ]);
  }
  console.log(chalk.bold('📊 字段画像'));
  console.log(colTable.toString());
  console.log('');

  if (report.problems.length > 0) {
    console.log(chalk.bold('⚠️  问题排行 (Top 10)'));
    const topProblems = report.problems.slice(0, 10);
    for (let i = 0; i < topProblems.length; i++) {
      const p = topProblems[i];
      const sev = severityColor(p.severity);
      console.log(`  ${i + 1}. ${sev('[' + p.severity.toUpperCase() + ']')} ${p.column !== '__global__' ? p.column + ': ' : ''}${p.message}`);
    }
    console.log('');
  }
}

function generateMarkdown(report, beforeProfile = null, afterStats = null) {
  const lines = [];
  lines.push('# CSV 数据质量检测报告\n');
  lines.push(`> 生成时间: ${new Date().toLocaleString('zh-CN')}\n`);

  lines.push('## 📁 文件信息\n');
  lines.push('| 项目 | 值 |');
  lines.push('|------|-----|');
  lines.push(`| 文件 | \`${report.file}\` |`);
  lines.push(`| 编码 | ${report.detection.encoding} |`);
  lines.push(`| 分隔符 | \`${report.detection.delimiter === '\t' ? '\\t' : report.detection.delimiter}\` |`);
  lines.push(`| 行数 | ${report.rowCount} |`);
  lines.push(`| 列数 | ${report.columnCount} |`);
  lines.push(`| 重复行 | ${report.duplicateRows} |`);
  lines.push(`| 总空值率 | ${formatPct(report.totalEmptyRate)} |\n`);

  lines.push('## 🎯 综合评分\n');
  const stars = '★'.repeat(Math.round(report.score / 20)) + '☆'.repeat(5 - Math.round(report.score / 20));
  lines.push(`| 分数 | 等级 | 评级 |`);
  lines.push(`|------|------|------|`);
  lines.push(`| **${report.score}** / 100 | **${report.grade}** | ${stars} |\n`);

  if (beforeProfile && afterStats) {
    lines.push('## 🔄 清洗前后对比\n');
    lines.push('| 指标 | 清洗前 | 清洗后 | 变化 |');
    lines.push('|------|--------|--------|------|');
    lines.push(`| 行数 | ${beforeProfile.rowCount} | ${afterStats.totalRows - afterStats.removedDuplicates} | -${afterStats.removedDuplicates} |`);
    lines.push(`| 变更行数 | - | ${afterStats.changedRows} | +${afterStats.changedRows} |`);
    lines.push(`| 变更字段 | - | ${afterStats.changedFields} | +${afterStats.changedFields} |`);
    lines.push(`| 质量分 | ${beforeProfile.score} | ${report.score} | +${(report.score - beforeProfile.score).toFixed(1)} |\n`);
  }

  lines.push('## 📊 字段画像\n');
  lines.push('| 列名 | 类型 | 置信度 | 空值率 | 唯一值 | 问题 |');
  lines.push('|------|------|--------|--------|--------|------|');
  for (const col of report.header) {
    const c = report.columns[col];
    let extra = '';
    if (c.type === 'integer' || c.type === 'number') {
      extra = ` [${formatNum(c.stats.min)} ~ ${formatNum(c.stats.max)}]`;
    } else if (c.type === 'date') {
      extra = ` (${c.format || '未知格式'})`;
    } else if (c.type === 'enum') {
      extra = ` (${c.values.length}个值)`;
    }
    lines.push(`| \`${col}\` | ${c.type}${extra} | ${formatPct(c.confidence)} | ${formatPct(c.stats.emptyRate)} | ${c.stats.unique} | ${c.issues.map(i => `**${i.severity}**: ${i.message}`).join('; ') || '-'} |`);
  }
  lines.push('');

  if (report.problems.length > 0) {
    lines.push('## ⚠️ 问题清单\n');
    lines.push('| # | 严重程度 | 字段 | 类型 | 描述 |');
    lines.push('|---|----------|------|------|------|');
    report.problems.forEach((p, i) => {
      lines.push(`| ${i + 1} | ${p.severity.toUpperCase()} | ${p.column === '__global__' ? '*全局*' : `\`${p.column}\``} | ${p.type} | ${p.message} |`);
    });
    lines.push('');
  }

  lines.push('## 📈 数值字段分布\n');
  let hasNumeric = false;
  for (const col of report.header) {
    const c = report.columns[col];
    if (c.type === 'integer' || c.type === 'number') {
      if (!hasNumeric) { hasNumeric = true; }
      lines.push(`### \`${col}\`\n`);
      lines.push('| 指标 | 值 |');
      lines.push('|------|-----|');
      lines.push(`| 最小值 | ${formatNum(c.stats.min)} |`);
      lines.push(`| 最大值 | ${formatNum(c.stats.max)} |`);
      lines.push(`| 均值 | ${formatNum(c.stats.mean)} |`);
      lines.push(`| 中位数 | ${formatNum(c.stats.median)} |`);
      lines.push(`| Q1 | ${formatNum(c.stats.q1)} |`);
      lines.push(`| Q3 | ${formatNum(c.stats.q3)} |`);
      lines.push(`| 标准差 | ${formatNum(c.stats.stddev)} |`);
      lines.push(`| 异常值数量 | ${c.stats.outliers || 0} |\n`);
    }
  }
  if (!hasNumeric) {
    lines.push('_无数值字段_\n');
  }

  return lines.join('\n');
}

function generateHTML(report, beforeProfile = null, afterStats = null) {
  const md = generateMarkdown(report, beforeProfile, afterStats);
  const css = `
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1200px; margin: 40px auto; padding: 0 20px; color: #333; }
      h1 { border-bottom: 3px solid #2563eb; padding-bottom: 10px; color: #1e40af; }
      h2 { border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; margin-top: 30px; color: #1e3a8a; }
      h3 { color: #1e40af; }
      table { border-collapse: collapse; width: 100%; margin: 15px 0; }
      th, td { border: 1px solid #e5e7eb; padding: 10px 14px; text-align: left; }
      th { background: #eff6ff; color: #1e3a8a; }
      tr:nth-child(even) { background: #f9fafb; }
      code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
      blockquote { border-left: 4px solid #93c5fd; padding-left: 16px; color: #6b7280; }
      .grade-A { color: #059669; font-weight: bold; }
      .grade-B { color: #0891b2; font-weight: bold; }
      .grade-C { color: #d97706; font-weight: bold; }
      .grade-D { color: #7c3aed; font-weight: bold; }
      .grade-F { color: #dc2626; font-weight: bold; }
      .sev-high { color: #dc2626; font-weight: bold; }
      .sev-medium { color: #d97706; font-weight: bold; }
      .sev-low { color: #2563eb; font-weight: bold; }
      .score-box { display: inline-block; background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 30px 50px; border-radius: 12px; font-size: 48px; font-weight: bold; margin: 20px 0; }
    </style>
  `;

  let html = mdToHtml(md);
  html = html.replace(/HIGH/g, '<span class="sev-high">HIGH</span>');
  html = html.replace(/MEDIUM/g, '<span class="sev-medium">MEDIUM</span>');
  html = html.replace(/LOW/g, '<span class="sev-low">LOW</span>');
  html = html.replace(/\*\*(A)\*\*/g, '<span class="grade-A">$1</span>');
  html = html.replace(/\*\*(B)\*\*/g, '<span class="grade-B">$1</span>');
  html = html.replace(/\*\*(C)\*\*/g, '<span class="grade-C">$1</span>');
  html = html.replace(/\*\*(D)\*\*/g, '<span class="grade-D">$1</span>');
  html = html.replace(/\*\*(F)\*\*/g, '<span class="grade-F">$1</span>');
  html = html.replace(/\*\*(\d+(?:\.\d+)?) \/ 100\*\*/, '<div class="score-box">$1 / 100</div>');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>CSV 数据质量检测报告</title>
${css}
</head>
<body>
${html}
</body>
</html>`;
}

function mdToHtml(md) {
  let html = md;
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  const tableRegex = /(\|.+\|\n\|[-:|]+\|\n(?:\|.+\|\n?)+)/g;
  html = html.replace(tableRegex, (match) => {
    const lines = match.trim().split('\n').filter(l => l.trim());
    let tableHtml = '<table>';
    tableHtml += '<thead><tr>';
    for (const h of lines[0].split('|').slice(1, -1)) {
      tableHtml += `<th>${h.trim()}</th>`;
    }
    tableHtml += '</tr></thead><tbody>';
    for (let i = 2; i < lines.length; i++) {
      tableHtml += '<tr>';
      for (const c of lines[i].split('|').slice(1, -1)) {
        tableHtml += `<td>${c.trim()}</td>`;
      }
      tableHtml += '</tr>';
    }
    tableHtml += '</tbody></table>';
    return tableHtml + '\n';
  });

  html = html.replace(/\n{3,}/g, '\n\n');
  html = html.split('\n\n').map(p => {
    if (p.startsWith('<') || p.startsWith('\n')) return p;
    return `<p>${p}</p>`;
  }).join('\n\n');

  return html;
}

function writeReport(report, outputPath, format = 'markdown', beforeProfile = null, afterStats = null) {
  let content;
  if (format === 'html') {
    content = generateHTML(report, beforeProfile, afterStats);
  } else {
    content = generateMarkdown(report, beforeProfile, afterStats);
  }
  fs.writeFileSync(outputPath, content, 'utf-8');
  return outputPath;
}

module.exports = {
  printConsoleReport,
  generateMarkdown,
  generateHTML,
  writeReport
};
