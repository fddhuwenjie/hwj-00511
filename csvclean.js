#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

const CSVReader = require('./lib/csvReader');
const { QualityChecker } = require('./lib/qualityChecker');
const RuleEngine = require('./lib/ruleEngine');
const DataCleaner = require('./lib/dataCleaner');
const { printConsoleReport, writeReport } = require('./lib/reporter');
const RuleAuditor = require('./lib/ruleAuditor');

const program = new Command();

program
  .name('csvclean')
  .description('CSV 数据质量检测和清洗工具')
  .version('1.0.0');

program
  .command('profile <csvFile>')
  .description('生成CSV文件的数据画像和质量报告')
  .option('-r, --report <path>', '输出报告文件路径 (支持 .md 或 .html)')
  .option('-f, --format <format>', '报告格式: markdown|html (默认根据扩展名自动识别)', 'auto')
  .option('-t, --threshold <score>', 'CI模式：质量分低于此阈值返回非零退出码', parseFloat)
  .action(async (csvFile, options) => {
    try {
      if (!fs.existsSync(csvFile)) {
        console.error(chalk.red(`文件不存在: ${csvFile}`));
        process.exit(1);
      }

      console.log(chalk.cyan(`正在分析: ${csvFile}`));
      const checker = new QualityChecker(csvFile);
      const report = await checker.profile();

      printConsoleReport(report);

      if (options.report) {
        let format = options.format;
        if (format === 'auto') {
          const ext = path.extname(options.report).toLowerCase();
          format = ext === '.html' ? 'html' : 'markdown';
        }
        const outPath = writeReport(report, options.report, format);
        console.log(chalk.green(`✓ 报告已保存: ${outPath}`));
      }

      if (options.threshold !== undefined && report.score < options.threshold) {
        console.log(chalk.red(`\n✗ 质量分 ${report.score} 低于阈值 ${options.threshold}`));
        process.exit(2);
      }
    } catch (err) {
      console.error(chalk.red('分析失败:'), err.message);
      process.exit(1);
    }
  });

program
  .command('validate <csvFile>')
  .description('根据YAML规则文件验证CSV数据')
  .option('-u, --rules <rulesFile>', 'YAML规则文件路径', 'rules.yaml')
  .option('-o, --output <path>', '验证结果输出路径 (JSON)')
  .option('-q, --quiet', '仅输出问题行')
  .option('-t, --threshold <score>', 'CI模式：错误数超过阈值返回非零退出码', parseInt)
  .action(async (csvFile, options) => {
    try {
      if (!fs.existsSync(csvFile)) {
        console.error(chalk.red(`文件不存在: ${csvFile}`));
        process.exit(1);
      }
      if (!fs.existsSync(options.rules)) {
        console.error(chalk.red(`规则文件不存在: ${options.rules}`));
        process.exit(1);
      }

      console.log(chalk.cyan(`正在验证: ${csvFile}`));
      console.log(chalk.cyan(`使用规则: ${options.rules}`));

      const ruleEngine = new RuleEngine();
      ruleEngine.load(options.rules);

      const reader = new CSVReader(csvFile);
      await reader.detect();

      let totalRows = 0;
      let errorRows = 0;
      let warningRows = 0;
      const allIssues = [];

      await new Promise((resolve, reject) => {
        reader.read(
          (row, lineNum, rowIndex) => {
            totalRows++;
            const result = ruleEngine.validateRow(row, lineNum, rowIndex);
            if (result.issues.length > 0) errorRows++;
            if (result.warnings.length > 0) warningRows++;
            for (const issue of result.issues) {
              allIssues.push({ lineNum, severity: 'error', ...issue });
              if (!options.quiet) {
                console.log(chalk.red(`  [ERROR] 行${lineNum} ${issue.field || ''}: ${issue.message}`));
              }
            }
            for (const warn of result.warnings) {
              allIssues.push({ lineNum, severity: 'warning', ...warn });
              if (!options.quiet) {
                console.log(chalk.yellow(`  [WARN]  行${lineNum} ${warn.field || ''}: ${warn.message}`));
              }
            }
          },
          () => resolve()
        );
        reader.on('error', reject);
      });

      console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(`总行数: ${totalRows}`);
      console.log(chalk.red(`错误行: ${errorRows}`));
      console.log(chalk.yellow(`警告行: ${warningRows}`));
      console.log(`通过率: ${((totalRows - errorRows) / totalRows * 100).toFixed(1)}%`);

      if (options.output) {
        fs.writeFileSync(options.output, JSON.stringify({
          source: csvFile,
          rules: options.rules,
          totalRows,
          errorRows,
          warningRows,
          issues: allIssues
        }, null, 2), 'utf-8');
        console.log(chalk.green(`\n✓ 验证结果已保存: ${options.output}`));
      }

      if (options.threshold !== undefined && errorRows > options.threshold) {
        console.log(chalk.red(`\n✗ 错误行 ${errorRows} 超过阈值 ${options.threshold}`));
        process.exit(2);
      }
    } catch (err) {
      console.error(chalk.red('验证失败:'), err.message);
      process.exit(1);
    }
  });

program
  .command('clean <csvFile>')
  .description('按规则清洗CSV数据，生成清洗后文件和变更日志')
  .option('-u, --rules <rulesFile>', 'YAML规则文件路径', 'rules.yaml')
  .option('-o, --output <path>', '清洗后CSV输出路径')
  .option('-l, --changelog <path>', '变更日志输出路径 (JSON)')
  .option('-v, --review <path>', '生成抽样审查文件 review.csv')
  .option('-r, --report <path>', '输出清洗后质量报告路径')
  .option('-f, --format <format>', '报告格式: markdown|html', 'markdown')
  .action(async (csvFile, options) => {
    try {
      if (!fs.existsSync(csvFile)) {
        console.error(chalk.red(`文件不存在: ${csvFile}`));
        process.exit(1);
      }

      const outputPath = options.output || csvFile.replace(/\.csv$/i, '.clean.csv');
      const changelogPath = options.changelog;
      const reviewPath = options.review || (options.output ? options.output.replace(/\.csv$/i, '') : csvFile.replace(/\.csv$/i, '')) + '.review.csv';

      console.log(chalk.cyan(`正在清洗: ${csvFile}`));
      if (fs.existsSync(options.rules)) {
        console.log(chalk.cyan(`使用规则: ${options.rules}`));
      } else {
        console.log(chalk.yellow(`⚠ 规则文件未找到: ${options.rules}，将使用默认清洗规则`));
      }

      const beforeChecker = new QualityChecker(csvFile);
      const beforeProfile = await beforeChecker.profile();

      const cleaner = new DataCleaner(csvFile);
      const result = await cleaner.clean(
        fs.existsSync(options.rules) ? options.rules : null,
        outputPath,
        {
          changelogPath,
          includeReview: true,
          reviewPath: options.review !== undefined ? reviewPath : null
        }
      );

      console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(`总行数:     ${result.stats.totalRows}`);
      console.log(chalk.green(`变更行数:   ${result.stats.changedRows}`));
      console.log(chalk.green(`变更字段:   ${result.stats.changedFields}`));
      console.log(chalk.red(`删除重复行: ${result.stats.removedDuplicates}`));
      if (result.reviewPath) console.log(chalk.blue(`审查行数:   ${result.stats.reviewRows}`));
      console.log('');

      console.log(chalk.green(`✓ 清洗后文件: ${outputPath}`));
      if (result.changelogPath) console.log(chalk.green(`✓ 变更日志:   ${result.changelogPath}`));
      if (result.reviewPath) console.log(chalk.green(`✓ 审查文件:   ${result.reviewPath}`));

      if (options.report) {
        const afterChecker = new QualityChecker(outputPath);
        const afterProfile = await afterChecker.profile();
        const reportPath = writeReport(afterProfile, options.report, options.format, beforeProfile, result.stats);
        console.log(chalk.green(`✓ 质量报告:   ${reportPath}`));
        console.log(chalk.cyan(`  清洗前: ${beforeProfile.score} 分 → 清洗后: ${afterProfile.score} 分 (+${(afterProfile.score - beforeProfile.score).toFixed(1)})`));
      }
    } catch (err) {
      console.error(chalk.red('清洗失败:'), err.message);
      console.error(err.stack);
      process.exit(1);
    }
  });

program
  .command('merge <originalCsv> <reviewCsv>')
  .description('将人工修改后的review.csv合并回原始CSV数据')
  .option('-o, --output <path>', '合并后CSV输出路径')
  .action(async (originalCsv, reviewCsv, options) => {
    try {
      if (!fs.existsSync(originalCsv)) {
        console.error(chalk.red(`原始文件不存在: ${originalCsv}`));
        process.exit(1);
      }
      if (!fs.existsSync(reviewCsv)) {
        console.error(chalk.red(`审查文件不存在: ${reviewCsv}`));
        process.exit(1);
      }

      const outputPath = options.output || originalCsv.replace(/\.csv$/i, '.merged.csv');
      console.log(chalk.cyan(`正在合并: ${originalCsv} + ${reviewCsv}`));

      const result = await DataCleaner.mergeReview(originalCsv, reviewCsv, outputPath);
      console.log(chalk.green(`✓ 已合并 ${result.merged} 条审查记录`));
      console.log(chalk.green(`✓ 输出文件: ${result.output}`));
    } catch (err) {
      console.error(chalk.red('合并失败:'), err.message);
      process.exit(1);
    }
  });

program
  .command('audit-rules <csvFile>')
  .description('审计CSV规则覆盖率，生成修复建议和YAML片段')
  .option('-u, --rules <rulesFile>', 'YAML规则文件路径', 'rules.yaml')
  .option('-m, --markdown <path>', '输出 Markdown 审计报告路径')
  .option('-j, --json <path>', '输出 JSON 审计报告路径')
  .option('-q, --quiet', '不打印控制台摘要')
  .action(async (csvFile, options) => {
    try {
      if (!fs.existsSync(csvFile)) {
        console.error(chalk.red(`文件不存在: ${csvFile}`));
        process.exit(1);
      }
      if (!fs.existsSync(options.rules)) {
        console.error(chalk.red(`规则文件不存在: ${options.rules}`));
        process.exit(1);
      }

      console.log(chalk.cyan(`正在审计: ${csvFile}`));
      console.log(chalk.cyan(`使用规则: ${options.rules}`));

      const auditor = new RuleAuditor(csvFile, options.rules);
      const report = await auditor.audit();

      if (!options.quiet) {
        console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.bold('          规则审计摘要'));
        console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
        console.log(`📊 字段覆盖率: ${chalk.green((report.coverage.coverageRate * 100).toFixed(1) + '%')} (${report.coverage.coveredFields}/${report.coverage.totalFields})`);
        console.log(`🔍 未约束字段: ${chalk.yellow(report.coverage.uncoveredFields)} 个`);
        if (report.coverage.uncoveredFields.length > 0) {
          console.log(`   → ${report.coverage.uncoveredFieldNames.join(', ')}`);
        }
        console.log(`⚠️  规则数据冲突: ${chalk.red(report.ruleDataConflicts.length)} 项`);
        console.log(`🎯 枚举候选: ${report.enumCandidates.length} 个`);
        console.log(`📅 日期格式问题: ${report.dateFormatIssues.length} 个`);
        console.log(`🔑 唯一键风险/候选: ${report.uniqueKeyRisks.length} 个`);
        console.log(`🔗 跨字段规则命中/建议: ${report.crossFieldRuleHits.length} 个`);
        console.log(`💡 修复建议总数: ${chalk.cyan(report.suggestions.length)} 条`);

        if (report.suggestions.length > 0) {
          console.log(chalk.bold('\n📋 修复建议 Top 5 (按置信度):'));
          const top5 = report.suggestions.slice(0, 5);
          for (let i = 0; i < top5.length; i++) {
            const s = top5[i];
            const confColor = s.confidenceLabel === 'high' ? chalk.red : s.confidenceLabel === 'medium' ? chalk.yellow : chalk.blue;
            console.log(`  ${i + 1}. ${confColor('[' + s.confidenceLabel.toUpperCase() + ']')} ${s.title}`);
            console.log(`     ${s.description}`);
          }
        }
      }

      if (options.markdown) {
        RuleAuditor.writeMarkdownReport(report, options.markdown);
        console.log(chalk.green(`\n✓ Markdown 报告已保存: ${options.markdown}`));
      }
      if (options.json) {
        RuleAuditor.writeJsonReport(report, options.json);
        console.log(chalk.green(`✓ JSON 报告已保存: ${options.json}`));
      }
    } catch (err) {
      console.error(chalk.red('审计失败:'), err.message);
      console.error(err.stack);
      process.exit(1);
    }
  });

program
  .command('inspect <csvFile>')
  .description('查看CSV文件基本信息（编码、分隔符、表头、前5行）')
  .option('-n, --rows <n>', '显示前N行', parseInt, 5)
  .action(async (csvFile, options) => {
    try {
      if (!fs.existsSync(csvFile)) {
        console.error(chalk.red(`文件不存在: ${csvFile}`));
        process.exit(1);
      }

      const reader = new CSVReader(csvFile);
      const detection = await reader.detect();

      console.log(chalk.bold('\n📋 CSV 文件信息'));
      console.log(`  文件:       ${csvFile}`);
      console.log(`  文件大小:   ${(fs.statSync(csvFile).size / 1024).toFixed(2)} KB`);
      console.log(`  编码:       ${chalk.cyan(detection.encoding)}`);
      console.log(`  分隔符:     ${chalk.cyan(JSON.stringify(detection.delimiter))}`);
      console.log('');

      let count = 0;
      await new Promise((resolve, reject) => {
        reader.read(
          (row, lineNum) => {
            if (count === 0) {
              console.log(chalk.bold('📑 表头: ') + reader.header.map(h => chalk.cyan(h)).join(', '));
              console.log(`\n📝 前 ${options.rows} 行数据:`);
            }
            if (count < options.rows) {
              console.log(chalk.gray(`  [行${lineNum}] `) + JSON.stringify(row));
            }
            count++;
          },
          () => {
            console.log(`\n共 ${count} 行数据`);
            resolve();
          }
        );
        reader.on('error', reject);
      });
    } catch (err) {
      console.error(chalk.red('查看失败:'), err.message);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
