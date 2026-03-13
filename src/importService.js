import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';

class ImportService {
  /**
   * 从 CSV 文件导入数据
   * @param {string} csvFilePath - CSV 文件路径
   * @returns {Promise<Object>}
   */
  async importFromCSV(csvFilePath) {
    console.log(`📖 从 CSV 导入: ${csvFilePath}`);

    try {
      const fileContent = await fs.readFile(csvFilePath, 'utf-8');
      const records = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });

      console.log(`✓ 成功读取 ${records.length} 条记录`);

      return {
        format: 'csv',
        filePath: csvFilePath,
        records: records,
        total: records.length,
      };
    } catch (error) {
      console.error('CSV 导入失败:', error.message);
      throw error;
    }
  }

  /**
   * 从 JSON 文件导入数据
   * @param {string} jsonFilePath - JSON 文件路径
   * @returns {Promise<Object>}
   */
  async importFromJSON(jsonFilePath) {
    console.log(`📖 从 JSON 导入: ${jsonFilePath}`);

    try {
      const fileContent = await fs.readFile(jsonFilePath, 'utf-8');
      const data = JSON.parse(fileContent);

      // 支持两种 JSON 格式：
      // 1. 直接数组
      // 2. 包含 records 字段的对象
      const records = Array.isArray(data) ? data : data.records || [];

      console.log(`✓ 成功读取 ${records.length} 条记录`);

      return {
        format: 'json',
        filePath: jsonFilePath,
        records: records,
        total: records.length,
        properties: data.properties || null,
      };
    } catch (error) {
      console.error('JSON 导入失败:', error.message);
      throw error;
    }
  }

  /**
   * 从 JSONL 文件导入数据（流式）
   * @param {string} jsonlFilePath - JSONL 文件路径
   * @returns {Promise<Object>}
   */
  async importFromJSONL(jsonlFilePath) {
    console.log(`📖 从 JSONL 导入: ${jsonlFilePath}`);

    try {
      const fileContent = await fs.readFile(jsonlFilePath, 'utf-8');
      const lines = fileContent.trim().split('\n').filter((line) => line.length > 0);

      const records = lines.map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          console.warn(`⚠️  第 ${index + 1} 行 JSON 解析失败，跳过`);
          return null;
        }
      }).filter((record) => record !== null);

      console.log(`✓ 成功读取 ${records.length} 条记录`);

      return {
        format: 'jsonl',
        filePath: jsonlFilePath,
        records: records,
        total: records.length,
      };
    } catch (error) {
      console.error('JSONL 导入失败:', error.message);
      throw error;
    }
  }

  /**
   * 从 Notion Markdown 导出目录导入数据
   * @param {string} exportDirPath - Notion 导出目录路径
   * @returns {Promise<Object>}
   */
  async importFromNotionMarkdownExport(exportDirPath) {
    console.log(`📖 从 Notion Markdown 导出目录导入: ${exportDirPath}`);

    const rootEntries = await fs.readdir(exportDirPath, { withFileTypes: true });
    const hasSubDirectory = rootEntries.some((entry) => entry.isDirectory());

    const markdownFiles = await this._collectMarkdownFiles(exportDirPath, {
      includeRootMarkdown: !hasSubDirectory,
    });

    const records = [];
    for (const mdPath of markdownFiles) {
      const record = await this._parseNotionMarkdownFile(exportDirPath, mdPath);
      if (record) {
        records.push(record);
      }
    }

    console.log(`✓ 成功读取 ${records.length} 条 Markdown 记录`);

    return {
      format: 'notion-markdown-dir',
      filePath: exportDirPath,
      records,
      total: records.length,
    };
  }

  /**
   * 规范化记录数据格式
   * @param {Array} records - 原始记录数组
   * @returns {Array} 规范化后的记录
   */
  normalizeRecords(records) {
    return records.map((record) => {
      // 如果记录是嵌套对象（包含 properties 字段），则展平它
      if (record.properties && typeof record.properties === 'object') {
        return {
          ...record,
          ...record.properties,
        };
      }

      return record;
    });
  }

  /**
   * 获取所有列名（字段名）
   * @param {Array} records - 记录数组
   * @returns {Array<string>} 列名数组
   */
  getColumns(records) {
    const columnSet = new Set();

    for (const record of records) {
      Object.keys(record).forEach((key) => columnSet.add(key));
    }

    return Array.from(columnSet);
  }

  /**
   * 预览数据
   * @param {Object} importedData - 导入的数据对象
   * @param {number} limit - 预览行数
   */
  previewData(importedData, limit = 5) {
    const { records, total, format } = importedData;
    const previewRecords = records.slice(0, limit);

    console.log(`\n📊 数据预览 (共 ${total} 条记录，显示前 ${Math.min(limit, total)} 条):`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    previewRecords.forEach((record, index) => {
      console.log(`\n记录 ${index + 1}:`);
      const displayRecord = typeof record === 'object' ? record : { value: record };
      const compactRecord = {};

      for (const [key, value] of Object.entries(displayRecord)) {
        if (typeof value === 'string' && value.length > 400) {
          compactRecord[key] = `${value.slice(0, 400)}... (已截断 ${value.length - 400} 字符)`;
        } else {
          compactRecord[key] = value;
        }
      }
      console.log(JSON.stringify(compactRecord, null, 2));
    });

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  }

  /**
   * 验证数据有效性
   * @param {Array} records - 记录数组
   * @returns {Object} 验证结果
   */
  validateData(records) {
    const issues = [];
    let emptyRecordCount = 0;

    records.forEach((record, index) => {
      if (!record || Object.keys(record).length === 0) {
        emptyRecordCount++;
      }
    });

    if (emptyRecordCount > 0) {
      issues.push(`${emptyRecordCount} 条空记录`);
    }

    return {
      isValid: issues.length === 0,
      issues: issues,
      total: records.length,
      empty: emptyRecordCount,
      valid: records.length - emptyRecordCount,
    };
  }

  /**
   * 递归收集 Markdown 文件
   * @private
   */
  async _collectMarkdownFiles(dirPath, options = { includeRootMarkdown: true }, rootPath = dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const subFiles = await this._collectMarkdownFiles(absolutePath, options, rootPath);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const isRootFile = path.resolve(dirPath) === path.resolve(rootPath);
        if (isRootFile && !options.includeRootMarkdown) {
          continue;
        }
        files.push(absolutePath);
      }
    }

    return files;
  }

  /**
   * 解析 Notion 导出的单个 Markdown 文件
   * @private
   */
  async _parseNotionMarkdownFile(exportDirPath, markdownFilePath) {
    const content = await fs.readFile(markdownFilePath, 'utf-8');
    const lines = content.split(/\r?\n/);

    if (lines.length === 0) {
      return null;
    }

    const titleMatch = lines[0].match(/^#\s+(.+)$/);
    const title = titleMatch ? titleMatch[1].trim() : path.basename(markdownFilePath, '.md');

    const properties = {};
    let i = 1;

    while (i < lines.length && lines[i].trim() === '') {
      i++;
    }

    while (i < lines.length) {
      const line = lines[i].trim();

      if (!line) {
        break;
      }

      const propMatch = line.match(/^([^:\n]{1,80}):\s*(.+)$/);
      if (!propMatch) {
        break;
      }

      properties[propMatch[1].trim()] = propMatch[2].trim();
      i++;
    }

    while (i < lines.length && lines[i].trim() === '') {
      i++;
    }

    const bodyLines = lines.slice(i);
    const body = bodyLines.join('\n').trim();
    const excerpt = body.replace(/\s+/g, ' ').slice(0, 280);

    const attachments = [];
    const attachmentRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;
    while ((match = attachmentRegex.exec(body)) !== null) {
      const [, name, link] = match;
      if (!link.toLowerCase().endsWith('.md')) {
        attachments.push(`${name}|${decodeURIComponent(link)}`);
      }
    }

    const relativePath = path.relative(exportDirPath, markdownFilePath).replace(/\\/g, '/');

    return {
      标题: title,
      ...properties,
      内容摘要: excerpt,
      正文Markdown: body,
      附件: attachments.join('\n'),
      源文件: relativePath,
    };
  }
}

export default ImportService;
