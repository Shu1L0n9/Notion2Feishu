import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import FeishuDocClient from './feishuDocClient.js';

dotenv.config();

function cleanName(rawName) {
  let name = rawName.replace(/\.md$/i, '');
  name = name.replace(/\s[0-9a-f]{32}$/i, '');
  return name.trim().slice(0, 255) || '未命名';
}

function normalizeFsPath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}

function safeDecodePath(raw) {
  let out = String(raw || '');
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) {
        break;
      }
      out = next;
    } catch {
      break;
    }
  }
  return out;
}

function extractTitleAndBody(markdown) {
  const lines = markdown.split(/\r?\n/);
  if (!lines.length) {
    return { title: '未命名', body: '' };
  }

  const titleMatch = lines[0].match(/^#\s+(.+)$/);
  const title = titleMatch ? titleMatch[1].trim() : '未命名';
  const body = titleMatch ? lines.slice(1).join('\n').trim() : markdown.trim();
  return { title, body };
}

async function collectNotionPageNodes(localDir) {
  const entries = await fs.readdir(localDir, { withFileTypes: true });
  const dirMap = new Map();
  const mdMap = new Map();

  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirMap.set(cleanName(entry.name), path.join(localDir, entry.name));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      mdMap.set(cleanName(entry.name), path.join(localDir, entry.name));
    }
  }

  const pageNames = Array.from(new Set([...dirMap.keys(), ...mdMap.keys()]))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));

  const nodes = [];
  for (const pageName of pageNames) {
    const mdPath = mdMap.get(pageName) || null;
    const dirPath = dirMap.get(pageName) || null;

    let title = pageName;
    let body = '';
    if (mdPath) {
      const markdown = await fs.readFile(mdPath, 'utf-8');
      const parsed = extractTitleAndBody(markdown);
      if (parsed.title && parsed.title !== '未命名') {
        title = parsed.title;
      }
      body = parsed.body || '';
    }

    const children = dirPath ? await collectNotionPageNodes(dirPath) : [];
    nodes.push({
      title,
      body,
      mdPath,
      dirPath,
      children,
    });
  }

  return nodes;
}

async function migrateDocxNestedNode(client, node, parentNodeToken, rootDir, context) {
  if (context.limit > 0 && context.processed >= context.limit) {
    return null;
  }

  const created = await client.createDoc(node.title, parentNodeToken);
  const documentId = created.document_id || created.token;
  const nodeToken = created.node_token || '';

  context.processed += 1;

  const relPath = (node.mdPath || node.dirPath || '').replace(rootDir, '').replace(/^\\+/, '').replace(/\\/g, '/');
  console.log(`📄 页面: ${relPath || node.title} -> ${node.title} (doc=${documentId})`);

  const descendantIndex = new Map();

  for (const childNode of node.children) {
    if (context.limit > 0 && context.processed >= context.limit) {
      break;
    }

    const childResult = await migrateDocxNestedNode(client, childNode, nodeToken, rootDir, context);
    if (childResult?.indexMap) {
      for (const [key, value] of childResult.indexMap.entries()) {
        descendantIndex.set(key, value);
      }
    }
  }

  if (node.body) {
    try {
      await client.writeDocument(documentId, node.body, {
        markdownFilePath: node.mdPath,
        mode: 'docx_nested',
        documentId,
        pageTitle: node.title,
        resolveMarkdownDocLink: ({ absPath }) => {
          const norm = normalizeFsPath(absPath);
          return descendantIndex.get(norm) || null;
        },
      });
    } catch (e) {
      const detail = e?.response?.data ? ` ${JSON.stringify(e.response.data)}` : '';
      console.warn(`⚠️ 页面内容写入失败（仅保留空页面）: ${node.title} - ${e.message}${detail}`);
    }
  }

  const selfIndex = new Map(descendantIndex);
  if (node.mdPath) {
    selfIndex.set(normalizeFsPath(path.resolve(node.mdPath)), {
      title: node.title,
      documentId,
      nodeToken,
    });
  }
  if (node.dirPath) {
    selfIndex.set(normalizeFsPath(path.resolve(node.dirPath)), {
      title: node.title,
      documentId,
      nodeToken,
    });
  }
  if (node.mdPath) {
    const mdDir = path.dirname(path.resolve(node.mdPath));
    const base = path.basename(node.mdPath);
    const decoded = safeDecodePath(base);
    selfIndex.set(normalizeFsPath(path.resolve(mdDir, decoded)), {
      title: node.title,
      documentId,
      nodeToken,
    });
  }

  return {
    title: node.title,
    documentId,
    nodeToken,
    indexMap: selfIndex,
  };
}

async function migrateAsDocxNested(client, absInput, context, parentToken) {
  if (parentToken) {
    console.warn('ℹ️ 当前为“我的文档库”模式，已忽略 FEISHU_PARENT_FOLDER_TOKEN。');
  }

  const personalSpace = await client.getPersonalSpace();
  console.log(`✅ 已定位“我的文档库”空间: ${personalSpace.spaceId}`);

  const rootNodeToken = personalSpace.rootNodeToken || '';
  console.log('✅ 将按 Notion 原目录结构直接写入“我的文档库”根层级\n');

  const topNodes = await collectNotionPageNodes(absInput);

  for (const node of topNodes) {
    if (context.limit > 0 && context.processed >= context.limit) {
      break;
    }

    await migrateDocxNestedNode(client, node, rootNodeToken, absInput, context);
  }

  return {
    rootFolderToken: '',
    rootFolderUrl: rootNodeToken ? `https://feishu.cn/wiki/${rootNodeToken}` : '',
    rootDocId: '',
    rootNodeToken,
  };
}


async function main() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const userAccessToken = process.env.FEISHU_USER_ACCESS_TOKEN || '';

  if (!userAccessToken && (!appId || !appSecret)) {
    console.error('❌ 缺少凭证：请提供 FEISHU_USER_ACCESS_TOKEN 或 FEISHU_APP_ID + FEISHU_APP_SECRET');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const inputPath = args.find((arg) => !arg.startsWith('--'));
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 0;

  if (!inputPath) {
    console.error('❌ 用法: npm run migrate-docs <notion_export_dir>');
    process.exit(1);
  }

  const absInput = path.resolve(inputPath);
  const stat = await fs.stat(absInput);
  if (!stat.isDirectory()) {
    console.error('❌ 输入必须是目录');
    process.exit(1);
  }

  const client = new FeishuDocClient(appId, appSecret, {
    userAccessToken,
  });
  const parentToken = process.env.FEISHU_PARENT_FOLDER_TOKEN || '';

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Notion 页面树迁移到飞书“我的文档库”(仅 Docx)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const context = {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 0,
    processed: 0,
    rootToken: '',
    rootUrl: '',
  };

  const nestedResult = await migrateAsDocxNested(client, absInput, context, parentToken);
  context.rootToken = nestedResult.rootDocId;
  context.rootUrl = nestedResult.rootFolderUrl || '';

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 迁移完成');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`文档库入口: ${context.rootUrl || '(请在飞书“我的文档库”中查看新建文档)'}`);
}

main().catch((error) => {
  console.error('❌ 迁移失败:', error.message);
  if (error?.response?.data) {
    console.error(JSON.stringify(error.response.data));
  }
  process.exit(1);
});
