import NotionClient from './notionClient.js';
import FeishuClient from './feishuClient.js';
import { convertPropertyToField, convertPropertyValue, mapPropertyName } from './propertyMapper.js';

class MigrationService {
  constructor(notionClient, feishuClient) {
    this.notionClient = notionClient;
    this.feishuClient = feishuClient;
  }

  /**
   * 执行完整的迁移流程
   * @param {string} notionDatabaseId - Notion 数据库 ID
   * @param {string} feishuTableId - 飞书多维表格 ID
   */
  async migrate(notionDatabaseId, feishuTableId) {
    console.log('开始迁移...');

    try {
      // 步骤 1: 获取 Notion 数据库属性
      console.log('步骤 1: 获取 Notion 数据库属性...');
      const notionProperties = await this.notionClient.getDatabaseProperties(notionDatabaseId);
      console.log(`找到 ${Object.keys(notionProperties).length} 个属性`);

      // 步骤 2: 准备飞书字段
      console.log('步骤 2: 准备飞书字段...');
      const feishuFields = await this.prepareFeishuFields(feishuTableId, notionProperties);
      console.log(`成功创建/映射 ${feishuFields.length} 个字段`);

      // 步骤 3: 获取 Notion 页面
      console.log('步骤 3: 获取 Notion 数据...');
      const notionPages = await this.notionClient.getAllPages(notionDatabaseId);
      console.log(`找到 ${notionPages.length} 条记录`);

      // 步骤 4: 转换并迁移数据
      console.log('步骤 4: 转换并迁移数据到飞书...');
      await this.migrateRecords(feishuTableId, notionPages, notionProperties, feishuFields);

      console.log('迁移完成！');
    } catch (error) {
      console.error('迁移失败:', error.message);
      throw error;
    }
  }

  /**
   * 准备飞书字段
   * @private
   */
  async prepareFeishuFields(feishuTableId, notionProperties) {
    const existingFields = await this.feishuClient.getTableFields(feishuTableId);
    const existingFieldNames = new Set(existingFields.map((f) => f.field_name));

    const feishuFields = [];

    for (const [notionName, notionProperty] of Object.entries(notionProperties)) {
      const feishuName = mapPropertyName(notionName);

      if (!existingFieldNames.has(feishuName)) {
        try {
          const fieldConfig = convertPropertyToField(feishuName, notionProperty);
          const createdField = await this.feishuClient.createField(feishuTableId, fieldConfig);
          feishuFields.push({
            notionName,
            feishuName: createdField.field_name,
            feishuId: createdField.field_id,
            type: notionProperty.type,
          });
          console.log(`✓ 字段已创建: ${feishuName}`);
        } catch (error) {
          console.warn(`✗ 字段创建失败 ${feishuName}: ${error.message}`);
        }
      } else {
        const existingField = existingFields.find((f) => f.field_name === feishuName);
        feishuFields.push({
          notionName,
          feishuName: feishuName,
          feishuId: existingField.field_id,
          type: notionProperty.type,
        });
        console.log(`✓ 字段已存在: ${feishuName}`);
      }
    }

    return feishuFields;
  }

  /**
   * 迁移记录
   * @private
   */
  async migrateRecords(feishuTableId, notionPages, notionProperties, feishuFields) {
    const records = [];
    const batchSize = 100; // 飞书批量创建的限制

    for (const page of notionPages) {
      const notionProperties_extracted = this.notionClient.extractPageProperties(page);
      const feishuRecord = {};

      for (const field of feishuFields) {
        const value = notionProperties_extracted[field.notionName];
        const convertedValue = convertPropertyValue(value, field.type);

        if (convertedValue !== null && convertedValue !== undefined) {
          feishuRecord[field.feishuId] = convertedValue;
        }
      }

      records.push(feishuRecord);

      // 达到批次大小时，进行批量上传
      if (records.length >= batchSize) {
        await this.uploadBatch(feishuTableId, records);
        records.length = 0;
      }
    }

    // 上传剩余记录
    if (records.length > 0) {
      await this.uploadBatch(feishuTableId, records);
    }
  }

  /**
   * 上传一批记录
   * @private
   */
  async uploadBatch(feishuTableId, records) {
    try {
      const result = await this.feishuClient.batchCreateRecords(feishuTableId, records);
      console.log(`✓ 成功上传 ${result.length} 条记录`);
    } catch (error) {
      console.error(`✗ 批量上传失败: ${error.message}`);
      throw error;
    }
  }
}

export default MigrationService;
