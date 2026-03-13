import dotenv from 'dotenv';
import NotionClient from './notionClient.js';
import FeishuClient from './feishuClient.js';
import MigrationService from './migrationService.js';

dotenv.config();

async function main() {
  // 验证环境变量
  const requiredEnvVars = [
    'NOTION_API_KEY',
    'NOTION_DATABASE_ID',
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_TABLE_ID',
  ];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      console.error(`❌ 错误: 缺少环境变量 ${envVar}`);
      console.error('请在 .env 文件中设置所有必需的环境变量');
      process.exit(1);
    }
  }

  try {
    // 初始化客户端
    const notionClient = new NotionClient(process.env.NOTION_API_KEY);
    const feishuClient = new FeishuClient(process.env.FEISHU_APP_ID, process.env.FEISHU_APP_SECRET);

    // 创建迁移服务
    const migrationService = new MigrationService(notionClient, feishuClient);

    // 执行迁移
    await migrationService.migrate(process.env.NOTION_DATABASE_ID, process.env.FEISHU_TABLE_ID);
  } catch (error) {
    console.error('错误:', error.message);
    process.exit(1);
  }
}

main();
