const fs = require('fs');
const path = require('path');
const jschardet = require('jschardet');
const iconv = require('iconv-lite');
const { EventEmitter } = require('events');

class CSVReader extends EventEmitter {
  constructor(filePath, options = {}) {
    super();
    this.filePath = filePath;
    this.options = {
      encoding: 'auto',
      delimiter: 'auto',
      hasHeader: true,
      ...options
    };
    this.header = null;
    this.rowCount = 0;
    this.encoding = null;
    this.delimiter = null;
  }

  async detect() {
    const sampleSize = Math.min(fs.statSync(this.filePath).size, 64 * 1024);
    const fd = fs.openSync(this.filePath, 'r');
    const buffer = Buffer.alloc(sampleSize);
    fs.readSync(fd, buffer, 0, sampleSize, 0);
    fs.closeSync(fd);

    if (this.options.encoding === 'auto') {
      const detection = jschardet.detect(buffer);
      this.encoding = detection.encoding || 'utf-8';
      if (this.encoding.toLowerCase() === 'ascii') this.encoding = 'utf-8';
    } else {
      this.encoding = this.options.encoding;
    }

    let sampleText;
    try {
      sampleText = iconv.decode(buffer, this.encoding);
    } catch (e) {
      sampleText = buffer.toString('utf-8');
      this.encoding = 'utf-8';
    }

    if (this.options.delimiter === 'auto') {
      this.delimiter = this._detectDelimiter(sampleText);
    } else {
      this.delimiter = this.options.delimiter;
    }

    return { encoding: this.encoding, delimiter: this.delimiter };
  }

  _detectDelimiter(text) {
    const delimiters = [',', '\t', ';', '|'];
    const firstLines = text.split(/\r?\n/).slice(0, 10).filter(l => l.trim());
    if (firstLines.length === 0) return ',';

    let bestDelim = ',';
    let bestScore = -1;

    for (const delim of delimiters) {
      const counts = firstLines.map(line => this._countOutsideQuotes(line, delim));
      const nonZero = counts.filter(c => c > 0);
      if (nonZero.length === 0) continue;
      const avg = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
      const variance = nonZero.reduce((a, b) => a + (b - avg) ** 2, 0) / nonZero.length;
      const score = avg - variance * 2;
      if (score > bestScore) {
        bestScore = score;
        bestDelim = delim;
      }
    }

    return bestDelim;
  }

  _countOutsideQuotes(line, delimiter) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        count++;
      }
    }
    return count;
  }

  async read(onRow, onComplete) {
    await this.detect();

    const stream = fs.createReadStream(this.filePath);
    let decoder;
    try {
      decoder = iconv.getDecoder(this.encoding);
    } catch (e) {
      decoder = iconv.getDecoder('utf-8');
    }

    let buffer = '';
    let inQuotes = false;
    let lineNum = 0;
    let isFirstChunk = true;

    stream.on('data', (chunk) => {
      buffer += decoder.write(chunk);

      if (isFirstChunk && buffer.charCodeAt(0) === 0xFEFF) {
        buffer = buffer.slice(1);
      }
      isFirstChunk = false;

      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch === '"') {
          if (inQuotes && buffer[i + 1] === '"') {
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
          const line = buffer.slice(start, i);
          if (ch === '\r' && buffer[i + 1] === '\n') i++;
          start = i + 1;
          lineNum++;
          this._processLine(line, lineNum, onRow);
        }
      }
      buffer = buffer.slice(start);
    });

    stream.on('end', () => {
      if (buffer.trim()) {
        lineNum++;
        this._processLine(buffer, lineNum, onRow);
      }
      if (onComplete) onComplete({ rowCount: this.rowCount, header: this.header, encoding: this.encoding, delimiter: this.delimiter });
      this.emit('complete', { rowCount: this.rowCount, header: this.header, encoding: this.encoding, delimiter: this.delimiter });
    });

    stream.on('error', (err) => {
      this.emit('error', err);
    });
  }

  _processLine(line, lineNum, onRow) {
    if (!line.trim() && lineNum > 1) return;

    const fields = this._parseLine(line);

    if (lineNum === 1 && this.options.hasHeader) {
      this.header = fields.map(f => f.trim());
      this.emit('header', this.header);
      return;
    }

    if (!this.header) {
      this.header = fields.map((_, i) => `col_${i + 1}`);
    }

    this.rowCount++;
    const row = {};
    this.header.forEach((h, i) => {
      row[h] = fields[i] !== undefined ? fields[i] : '';
    });

    if (onRow) onRow(row, lineNum, this.rowCount);
    this.emit('row', row, lineNum, this.rowCount);
  }

  _parseLine(line) {
    const fields = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          field += '"';
          i++;
        } else if (inQuotes) {
          inQuotes = false;
        } else {
          inQuotes = true;
        }
      } else if (ch === this.delimiter && !inQuotes) {
        fields.push(this._normalizeValue(field));
        field = '';
      } else {
        field += ch;
      }
    }
    fields.push(this._normalizeValue(field));
    return fields;
  }

  _normalizeValue(value) {
    if (value === null || value === undefined) return '';
    const trimmed = value.trim();
    const lower = trimmed.toLowerCase();
    const nullValues = ['null', 'none', 'nan', 'n/a', 'na', '#n/a', ''];
    if (nullValues.includes(lower)) return '';
    return value;
  }

  static parseLine(line, delimiter = ',') {
    const reader = new CSVReader('', { delimiter });
    reader.delimiter = delimiter;
    return reader._parseLine(line);
  }

  static toCSV(rows, headers, delimiter = ',') {
    const lines = [];
    lines.push(headers.map(h => CSVReader._escapeField(h, delimiter)).join(delimiter));
    for (const row of rows) {
      lines.push(headers.map(h => CSVReader._escapeField(row[h] !== undefined ? row[h] : '', delimiter)).join(delimiter));
    }
    return lines.join('\r\n');
  }

  static _escapeField(value, delimiter) {
    if (value === null || value === undefined) value = '';
    value = String(value);
    if (value.includes('"') || value.includes(delimiter) || value.includes('\n') || value.includes('\r')) {
      value = '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
  }
}

module.exports = CSVReader;
