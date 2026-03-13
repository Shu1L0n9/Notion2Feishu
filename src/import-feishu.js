import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';
import FeishuClient from './feishuClient.js';
import ImportService from './importService.js';

dotenv.config();

const FIELD_TYPES = {
  TEXT: 1,
  NUMBER: 2,
  DATE: 5,
  CHECKBOX: 7,
  URL: 15,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }

  return /^https?:\/\//i.test(value.trim());
}

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', 'y', '1', '是'].includes(normalized)) {
    return true;
  }

  if (['false', 'no', 'n', '0', '否'].includes(normalized)) {
    return false;
  }

  return null;
}

function toTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return parsed;
}

function inferFieldType(samples) {
  if (!samples.length) {
    return FIELD_TYPES.TEXT;
  }

  let numberHits = 0;
  let dateHits = 0;
  let boolHits = 0;
  let urlHits = 0;

  for (const value of samples) {
    if (parseBoolean(value) !== null) {
      boolHits++;
    }

    if (!Number.isNaN(Number(value)) && String(value).trim() !== '') {
      numberHits++;
    }

    if (toTimestamp(value) !== null) {
      dateHits++;
    }

    if (looksLikeUrl(value)) {
      urlHits++;
    }
  }

  const threshold = Math.max(1, Math.floor(samples.length * 0.8));
  if (boolHits >= threshold) {
    return FIELD_TYPES.CHECKBOX;
  }

  if (numberHits >= threshold) {
    return FIELD_TYPES.NUMBER;
  }

  if (dateHits >= threshold) {
    return FIELD_TYPES.DATE;
  }

  if (urlHits >= threshold) {
    return FIELD_TYPES.URL;
  }

  return FIELD_TYPES.TEXT;
}

function normalizeByFieldType(value, fieldType) {
  if (value === null || value === undefined) {
    return '';
  }

  switch (fieldType) {
    case FIELD_TYPES.NUMBER: {
      const num = Number(value);
      return Number.isNaN(num) ? '' : num;
    }
    case FIELD_TYPES.DATE: {
      const ts = toTimestamp(value);
      return ts ?? '';
    }
    case FIELD_TYPES.CHECKBOX: {
      const bool = parseBoolean(value);
      return bool ?? false;
    }
    case FIELD_TYPES.URL:
      return String(value).slice(0, 50000);
    case FIELD_TYPES.TEXT:
    default:
      if (Array.isArray(value) || typeof value === 'object') {
        return JSON.stringify(value).slice(0, 50000);
      }
      return String(value).slice(0, 50000);
  }
}

async function ensureFeishuFields(feishuClient, tableId, normalizedRecords) {
  const existingFields = await feishuClient.getTableFields(tableId);
  const fieldIdMap = {};
  const fieldTypeMap = {};

  existingFields.forEach((field) => {
    fieldIdMap[field.field_name] = field.field_id;
    fieldTypeMap[field.field_name] = field.type;
  });

  const requiredColumns = new Set();
  for (const record of normalizedRecords) {
    Object.keys(record).forEach((key) => {
      if (key !== 'id' && key !== 'url') {
        requiredColumns.add(key);
      }
    });
  }

  for (const column of requiredColumns) {
    if (fieldIdMap[column]) {
      continue;
    }

    const samples = normalizedRecords
      .map((record) => record[column])
      .filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
      .slice(0, 50);

    const inferredType = inferFieldType(samples);

    try {
      const fieldConfig = {
        field_name: column.slice(0, 100),
        type: inferredType,
      };

      if (inferredType === FIELD_TYPES.DATE) {
        fieldConfig.property = { format: 'yyyy-MM-dd HH:mm' };
      }

      const created = await feishuClient.createField(tableId, {
        ...fieldConfig,
      });

      fieldIdMap[column] = created.field_id;
      fieldTypeMap[column] = inferredType;
      console.log(`✓ 自动创建字段: ${created.field_name} (type=${inferredType})`);
    } catch (error) {
      console.warn(`⚠️ 自动创建字段失败: ${column} (${error.message})`);
    }
  }

  return { fieldIdMap, fieldTypeMap };
}

async function resolveTargetTable(feishuClient) {
  let rawTable = (process.env.FEISHU_TABLE_ID || '').trim();
  let appToken = (process.env.FEISHU_APP_TOKEN || '').trim();
  const wantedTableName = (process.env.FEISHU_TABLE_NAME || '').trim();
  const wantedBaseName = (process.env.FEISHU_BASE_NAME || '').trim();
  const folderToken = (process.env.FEISHU_FOLDER_TOKEN || '').trim() || null;

  if (rawTable.startsWith('your_')) {
    rawTable = '';
  }

  if (appToken.startsWith('your_')) {
    appToken = '';
  }

  // 兼容旧格式：appToken/tableId
  if (rawTable.includes('/')) {
    return rawTable;
  }

  // 如果 FEISHU_TABLE_ID 只填了 tableId，则需要 FEISHU_APP_TOKEN
  if (rawTable && !appToken) {
    throw new Error('当 FEISHU_TABLE_ID 仅为 tableId 时，必须同时配置 FEISHU_APP_TOKEN');
  }

  // 如果没有 appToken，尝试自动取第一个可访问 app
  if (!appToken) {
    const autoBaseName = wantedBaseName || `NotionImport_${new Date().toISOString().slice(0, 10)}`;

    try {
      const createdApp = await feishuClient.createApp(autoBaseName, folderToken);
      appToken = createdApp.app_token;
      if (!appToken) {
        throw new Error('自动创建 Base 成功但未返回 app_token，请检查接口返回');
      }

      console.log(`✓ 已自动创建 Base: ${autoBaseName} (${appToken})`);

      if (createdApp.default_table_id) {
        console.log(`✓ 使用 Base 默认数据表: ${createdApp.default_table_id}`);
        return `${appToken}/${createdApp.default_table_id}`;
      }
    } catch (createErr) {
      // 创建失败则尝试读取已有 app
      try {
        const apps = await feishuClient.listApps();
        if (!apps.length) {
          throw createErr;
        }

        appToken = apps[0].app_token;
        console.log(`ℹ️ 自动创建 Base 失败，已回退使用已有 Base: ${appToken}`);
      } catch {
        throw createErr;
      }
    }
  }

  // 优先使用显式传入的 tableId
  if (rawTable) {
    return `${appToken}/${rawTable}`;
  }

  // 再尝试从表格列表中按名称或首个表格选择
  const tables = await feishuClient.listTables(appToken);
  if (tables.length) {
    let target = null;

    if (wantedTableName) {
      target = tables.find((t) => t.name === wantedTableName) || null;
    }

    if (!target) {
      target = tables[0];
    }

    console.log(`ℹ️ 自动使用表格: ${target.name || target.table_id}`);
    return `${appToken}/${target.table_id}`;
  }

  // 没有任何表格则自动创建
  const autoName = wantedTableName || `NotionImport_${new Date().toISOString().slice(0, 10)}`;
  const created = await feishuClient.createTable(appToken, autoName);
  const createdTableId = created?.table_id || created?.table?.table_id;
  if (!createdTableId) {
    throw new Error('自动创建表格成功但未返回 table_id，请检查接口返回');
  }

  console.log(`✓ 已自动创建表格: ${autoName} (${createdTableId})`);
  return `${appToken}/${createdTableId}`;
}

async function main() {
  const args = process.argv.slice(2);
  const importFile = args.find((arg) => !arg.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

  if (!importFile) {
    console.error('❌ 错误: 请指定导入文件路径');
    console.error('用法: npm run import-feishu <file_or_dir_path>');
    console.error('示例: npm run import-feishu ./exports/notion_export.csv');
    process.exit(1);
  }

  // 验证飞书配置（dry-run 不要求）
  if (!dryRun && (
    !process.env.FEISHU_APP_ID ||
    !process.env.FEISHU_APP_SECRET
  )) {
    console.error('❌ 错误: 缺少飞书配置');
    console.error('请在 .env 文件中设置:');
    console.error('  - FEISHU_APP_ID');
    console.error('  - FEISHU_APP_SECRET');
    console.error('  - FEISHU_TABLE_ID (可选: appToken/tableId 或仅 tableId)');
    console.error('  - FEISHU_APP_TOKEN (当 FEISHU_TABLE_ID 仅为 tableId 时必填)');
    process.exit(1);
  }

  try {
    // 初始化服务
    const importService = new ImportService();
    const feishuClient = dryRun
      ? null
      : new FeishuClient(process.env.FEISHU_APP_ID, process.env.FEISHU_APP_SECRET);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Notion 数据导入飞书');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const importPath = path.resolve(importFile);
    const stat = await fs.stat(importPath);

    // 根据输入类型导入数据
    let importedData;
    if (stat.isDirectory()) {
      importedData = await importService.importFromNotionMarkdownExport(importPath);
    } else {
      const ext = path.extname(importPath).toLowerCase();

      if (ext === '.csv') {
        importedData = await importService.importFromCSV(importPath);
      } else if (ext === '.json') {
        importedData = await importService.importFromJSON(importPath);
      } else if (ext === '.jsonl') {
        importedData = await importService.importFromJSONL(importPath);
      } else {
        console.error('❌ 不支持的文件格式:', ext);
        console.error('支持的输入: 目录(Notion Markdown 导出), .csv, .json, .jsonl');
        process.exit(1);
      }
    }

    // 预览数据
    importService.previewData(importedData, 3);

    // 验证数据
    console.log('\n✓ 验证数据...');
    const validation = importService.validateData(importedData.records);
    console.log(`  总记录数: ${validation.total}`);
    console.log(`  有效记录: ${validation.valid}`);
    if (validation.empty > 0) {
      console.log(`  ⚠️  空记录: ${validation.empty}`);
    }

    if (!validation.isValid) {
      console.warn('⚠️  数据包含问题:', validation.issues.join(', '));
    }

    console.log();

    // 规范化记录
    let normalizedRecords = importService.normalizeRecords(importedData.records);
    if (limit && Number.isFinite(limit) && limit > 0) {
      normalizedRecords = normalizedRecords.slice(0, limit);
      console.log(`\n🔎 测试模式: 仅处理前 ${normalizedRecords.length} 条记录`);
    }

    if (dryRun) {
      console.log('\n✅ dry-run 完成：数据解析正常，未写入飞书。');
      return;
    }

    // 获取并补齐飞书表格字段
    console.log('📋 获取并补齐飞书表格字段...');
    const tableId = await resolveTargetTable(feishuClient);
    console.log(`ℹ️ 目标表格: ${tableId}`);
    const { fieldIdMap, fieldTypeMap } = await ensureFeishuFields(feishuClient, tableId, normalizedRecords);
    console.log(`✓ 可用字段数: ${Object.keys(fieldIdMap).length}\n`);

    // 上传数据
    console.log('📤 上传数据到飞书...');
    const batchSize = 500;
    let uploadedCount = 0;

    for (let i = 0; i < normalizedRecords.length; i += batchSize) {
      const batch = normalizedRecords.slice(i, i + batchSize);

      // 转换记录格式
      const feishuRecords = batch.map((record) => {
        const feishuRecord = {};

        for (const [columnName, value] of Object.entries(record)) {
          // 查找对应的飞书字段 ID
          const fieldId = fieldIdMap[columnName];
          if (fieldId) {
            const fieldType = fieldTypeMap[columnName] || FIELD_TYPES.TEXT;
            feishuRecord[fieldId] = normalizeByFieldType(value, fieldType);
          } else if (columnName === 'id' || columnName === 'url') {
            // 跳过系统字段
            continue;
          } else {
            console.warn(`⚠️  字段未找到: ${columnName}，将跳过`);
          }
        }

        return feishuRecord;
      });

      try {
        const result = await feishuClient.batchCreateRecords(tableId, feishuRecords);
        uploadedCount += result.length;
        console.log(`✓ 第 ${Math.floor(i / batchSize) + 1} 批: 成功上传 ${result.length} 条记录 (总进度: ${uploadedCount}/${normalizedRecords.length})`);
        await sleep(120);
      } catch (error) {
        console.error(`✗ 第 ${Math.floor(i / batchSize) + 1} 批上传失败:`, error.message);
        throw error;
      }
    }

    console.log();
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ 导入完成！');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📊 导入结果: 成功上传 ${uploadedCount} 条记录到飞书`);
  } catch (error) {
    console.error('\n❌ 错误:', error.message);
    if (error?.response?.data) {
      console.error('❌ 接口返回:', JSON.stringify(error.response.data));
    }
    process.exit(1);
  }
}

main();
