import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import { parse } from 'csv-stringify/sync';

class ExportService {
  constructor(notionClient) {
    this.notionClient = notionClient;
  }

  /**
   * 导出 Notion 数据库到 JSON 文件
   * @param {string} databaseId - Notion 数据库 ID
   * @param {string} outputPath - 输出文件路径
   */
  async exportToJSON(databaseId, outputPath = null) {
    console.log('开始导出 Notion 数据到 JSON...');

    try {
      // 获取数据库属性
      const properties = await this.notionClient.getDatabaseProperties(databaseId);
      console.log(`找到 ${Object.keys(properties).length} 个属性`);

      // 获取所有页面
      const pages = await this.notionClient.getAllPages(databaseId);
      console.log(`找到 ${pages.length} 条记录`);

      // 转换数据
      const data = {
        exportDate: new Date().toISOString(),
        databaseId: databaseId,
        totalRecords: pages.length,
        properties: properties,
        records: pages.map((page) => ({
          id: page.id,
          url: page.url,
          createdTime: page.created_time,
          lastEditedTime: page.last_edited_time,
          properties: this.notionClient.extractPageProperties(page),
        })),
      };

      // 确定输出路径
      if (!outputPath) {
        outputPath = path.join('exports', `notion_export_${Date.now()}.json`);
      }

      // 创建目录
      const dir = path.dirname(outputPath);
      await fs.mkdir(dir, { recursive: true });

      // 写入文件
      await fs.writeFile(outputPath, JSON.stringify(data, null, 2), 'utf-8');

      console.log(`✓ 数据已导出到: ${outputPath}`);
      console.log(`  文件大小: ${(await fs.stat(outputPath)).size / 1024} KB`);

      return outputPath;
    } catch (error) {
      console.error('导出失败:', error.message);
      throw error;
    }
  }

  /**
   * 导出 Notion 数据库到 CSV 文件
   * @param {string} databaseId - Notion 数据库 ID
   * @param {string} outputPath - 输出文件路径
   */
  async exportToCSV(databaseId, outputPath = null) {
    console.log('开始导出 Notion 数据到 CSV...');

    try {
      // 获取数据库属性
      const properties = await this.notionClient.getDatabaseProperties(databaseId);
      const propertyNames = Object.keys(properties);
      console.log(`找到 ${propertyNames.length} 个属性`);

      // 获取所有页面
      const pages = await this.notionClient.getAllPages(databaseId);
      console.log(`找到 ${pages.length} 条记录`);

      // 准备 CSV 行
      const records = [];

      for (const page of pages) {
        const properties_extracted = this.notionClient.extractPageProperties(page);
        const record = {
          id: page.id,
          url: page.url,
          createdTime: page.created_time,
          lastEditedTime: page.last_edited_time,
        };

        // 添加所有属性值
        for (const propName of propertyNames) {
          record[propName] = this._formatValueForCSV(properties_extracted[propName]);
        }

        records.push(record);
      }

      // 确定输出路径
      if (!outputPath) {
        outputPath = path.join('exports', `notion_export_${Date.now()}.csv`);
      }

      // 创建目录
      const dir = path.dirname(outputPath);
      await fs.mkdir(dir, { recursive: true });

      // 转换为 CSV
      const csv = parse(records, {
        header: true,
        columns: ['id', 'url', 'createdTime', 'lastEditedTime', ...propertyNames],
      });

      // 写入文件
      await fs.writeFile(outputPath, csv, 'utf-8');

      console.log(`✓ 数据已导出到: ${outputPath}`);
      console.log(`  文件大小: ${(await fs.stat(outputPath)).size / 1024} KB`);

      return outputPath;
    } catch (error) {
      console.error('导出失败:', error.message);
      throw error;
    }
  }

  /**
   * 导出为 JSONL 格式（每行一条记录，便于流处理）
   * @param {string} databaseId - Notion 数据库 ID
   * @param {string} outputPath - 输出文件路径
   */
  async exportToJSONL(databaseId, outputPath = null) {
    console.log('开始导出 Notion 数据到 JSONL...');

    try {
      // 获取数据库属性
      const properties = await this.notionClient.getDatabaseProperties(databaseId);
      console.log(`找到 ${Object.keys(properties).length} 个属性`);

      // 确定输出路径
      if (!outputPath) {
        outputPath = path.join('exports', `notion_export_${Date.now()}.jsonl`);
      }

      // 创建目录
      const dir = path.dirname(outputPath);
      await fs.mkdir(dir, { recursive: true });

      // 创建输出流
      const writeStream = createWriteStream(outputPath, { encoding: 'utf-8' });

      // 流式处理页面
      let recordCount = 0;
      let cursor = undefined;
      let hasMore = true;

      while (hasMore) {
        const response = await this.notionClient.client.databases.query({
          database_id: databaseId,
          start_cursor: cursor,
        });

        for (const page of response.results) {
          const record = {
            id: page.id,
            url: page.url,
            createdTime: page.created_time,
            lastEditedTime: page.last_edited_time,
            properties: this.notionClient.extractPageProperties(page),
          };

          writeStream.write(JSON.stringify(record) + '\n');
          recordCount++;
        }

        hasMore = response.has_more;
        cursor = response.next_cursor;

        console.log(`已处理 ${recordCount} 条记录...`);
      }

      return new Promise((resolve, reject) => {
        writeStream.end(() => {
          console.log(`✓ 数据已导出到: ${outputPath}`);
          console.log(`  总记录数: ${recordCount}`);
          resolve(outputPath);
        });

        writeStream.on('error', reject);
      });
    } catch (error) {
      console.error('导出失败:', error.message);
      throw error;
    }
  }

  /**
   * 导出数据库结构（仅属性定义）
   * @param {string} databaseId - Notion 数据库 ID
   * @param {string} outputPath - 输出文件路径
   */
  async exportSchema(databaseId, outputPath = null) {
    console.log('开始导出数据库结构...');

    try {
      const properties = await this.notionClient.getDatabaseProperties(databaseId);

      const schema = {
        exportDate: new Date().toISOString(),
        databaseId: databaseId,
        properties: Object.entries(properties).map(([name, prop]) => ({
          name: name,
          type: prop.type,
          config: this._extractPropertyConfig(prop),
        })),
      };

      // 确定输出路径
      if (!outputPath) {
        outputPath = path.join('exports', `notion_schema_${Date.now()}.json`);
      }

      // 创建目录
      const dir = path.dirname(outputPath);
      await fs.mkdir(dir, { recursive: true });

      // 写入文件
      await fs.writeFile(outputPath, JSON.stringify(schema, null, 2), 'utf-8');

      console.log(`✓ 结构已导出到: ${outputPath}`);

      return outputPath;
    } catch (error) {
      console.error('导出失败:', error.message);
      throw error;
    }
  }

  /**
   * 私有方法：格式化值以适应 CSV
   * @private
   */
  _formatValueForCSV(value) {
    if (value === null || value === undefined) {
      return '';
    }

    if (Array.isArray(value)) {
      return value.join(';');
    }

    if (typeof value === 'object') {
      return JSON.stringify(value);
    }

    return String(value);
  }

  /**
   * 私有方法：提取属性配置
   * @private
   */
  _extractPropertyConfig(property) {
    const type = property.type;
    const config = {};

    switch (type) {
      case 'select':
      case 'multi_select':
        config.options = property[type]?.options?.map((opt) => ({
          name: opt.name,
          color: opt.color,
        }));
        break;
      case 'status':
        config.options = property.status?.options?.map((opt) => ({
          name: opt.name,
          color: opt.color,
        }));
        break;
      case 'number':
        config.format = property.number?.format;
        break;
      case 'relation':
        config.database_id = property.relation?.database_id;
        break;
      case 'rollup':
        config.relation_property_name = property.rollup?.relation_property_name;
        config.rollup_property_name = property.rollup?.rollup_property_name;
        config.function = property.rollup?.function;
        break;
    }

    return config;
  }
}

export default ExportService;
