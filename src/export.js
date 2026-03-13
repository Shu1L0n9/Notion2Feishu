import dotenv from 'dotenv';
import NotionClient from './notionClient.js';
import ExportService from './exportService.js';

dotenv.config();

async function main() {
  // 验证 Notion API Key 和 Database ID
  if (!process.env.NOTION_API_KEY || !process.env.NOTION_DATABASE_ID) {
    console.error('❌ 错误: 缺少 NOTION_API_KEY 或 NOTION_DATABASE_ID');
    console.error('请在 .env 文件中设置这些环境变量');
    process.exit(1);
  }

  try {
    // 初始化 Notion 客户端
    const notionClient = new NotionClient(process.env.NOTION_API_KEY);
    const exportService = new ExportService(notionClient);

    const databaseId = process.env.NOTION_DATABASE_ID;

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Notion 数据导出工具');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // 导出数据库结构
    console.log('📋 第 1 步: 导出数据库结构');
    const schemaPath = await exportService.exportSchema(databaseId);
    console.log();

    // 导出为 JSON
    console.log('📋 第 2 步: 导出数据为 JSON 格式');
    const jsonPath = await exportService.exportToJSON(databaseId);
    console.log();

    // 导出为 CSV
    console.log('📋 第 3 步: 导出数据为 CSV 格式');
    const csvPath = await exportService.exportToCSV(databaseId);
    console.log();

    // 导出为 JSONL
    console.log('📋 第 4 步: 导出数据为 JSONL 格式');
    const jsonlPath = await exportService.exportToJSONL(databaseId);
    console.log();

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ 导出完成！');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n📁 导出文件位置:');
    console.log(`  • 数据库结构: ${schemaPath}`);
    console.log(`  • JSON 格式: ${jsonPath}`);
    console.log(`  • CSV 格式: ${csvPath}`);
    console.log(`  • JSONL 格式: ${jsonlPath}`);
    console.log('\n💡 提示:');
    console.log('  • JSON 格式适合完整备份和后续导入');
    console.log('  • CSV 格式可以在 Excel/Google Sheets 中打开');
    console.log('  • JSONL 格式适合处理超大数据库（流式处理）');
  } catch (error) {
    console.error('❌ 错误:', error.message);
    process.exit(1);
  }
}

main();
