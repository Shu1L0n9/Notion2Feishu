# Notion 到飞书文档迁移工具

这是一个使用 JavaScript 的 Notion 导出文档到飞书云文档库的迁移工具。支持递归目录结构、图片附件、子文档链接，以及 Markdown 样式保留。

## 功能特性

- ✅ 递归迁移 Notion 导出的目录结构
- ✅ 保留完整的 Markdown 格式样式
  - 标题（h1-h5）
  - 加粗、斜体、删除线、行内代码、链接
  - 有序/无序列表（含嵌套）
  - 代办事项（Todo lists）
  - 代码块（fenced code）
  - 引用块、分割线
- ✅ 自动上传图片并保留正确的宽高比
- ✅ 支持文件附件上传
- ✅ 子文档引用（自动解析为链接）
- ✅ App ID + App Secret 自动获取/刷新 token（无需手动 OAuth）

## 快速开始

### 步骤 1: 在 Notion 中导出数据

1. 打开你要迁移的 Notion Workspace
2. 点击左侧 **Settings & members** → **Settings**
3. **Workspace** → **General** → **Export** → **Workspace content**
4. 选择格式：**Markdown & CSV**
5. 选择 **Create folders for subpages**
6. 点击 **Export** 按钮，保存 `.zip` 文件到本地
7. 解压 `.zip` 文件（例如得到 `ExportBlock/` 目录）

### 步骤 2: 获取飞书 API 凭证

访问 https://open.feishu.cn：

1. 登录你的飞书账号
2. 进入 **开发者后台** → **我的应用**
3. 点击 **创建企业应用**
4. 填写应用名称、描述等信息
5. 获取 **App ID** 和 **App Secret**

### 步骤 3: 配置凭证和个人知识库 ID

配置 `FEISHU_APP_ID` + `FEISHU_APP_SECRET`，程序会自动调用
`/auth/v3/tenant_access_token/internal` 获取并刷新 token，无需手动 OAuth。

获取个人知识库（Wiki Space）的 ID，作为迁移目标，将上述信息填入 `.env` 文件（示例）：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx

FEISHU_WIKI_SPACE_ID=7561127450958023410
```

### 步骤 4: 安装依赖

```bash
npm install
```

### 步骤 5: 迁移文档到飞书

```bash
npm run migrate-docs ./ExportBlock
```

该命令会：
- 递归遍历 `ExportBlock/` 目录
- 为每个 Markdown 文件创建飞书文档
- 自动上传所有图片和附件
- 保留文档间的链接关系

**可选参数：**
```bash
# 只迁移前 N 个文档（用于测试）
npm run migrate-docs ./ExportBlock --limit=5

# 启用详细日志
DEBUG=true npm run migrate-docs ./ExportBlock
```

## 环境要求

- Node.js >= 18.0.0
- npm 或 yarn

## 命令说明

| 命令 | 说明 |
| --- | --- |
| `npm run migrate-docs <dir>` | 迁移 Notion 导出目录到飞书云文档库 |
| `npm run dev` | 开发模式（监听文件变化） |

## 项目结构

```text
notion2feishu/
├── src/
│   ├── feishuDocClient.js    # 飞书文档 API 客户端
│   ├── migrate-docs.js       # 文档迁移入口脚本
│   └── ...
├── ExportBlock_demo/         # 演示数据集（包含所有支持的样式）
├── package.json
├── .env                      
└── README.md
```

## 支持的样式示例

详见 ExportBlock_demo/ 目录：

- **Project Notes aaaaa.md** - 主文档，展示所有支持的样式
- **API Design bbbb.md** - 子文档，演示文档链接
- **image.svg** - 图片示例
- **sample.txt** - 文件附件示例

## 常见问题

### Q: 迁移后某些样式没有显示？
A: 如果样式未显示，可能是因为：
- LaTeX 公式会被降级为纯文本（飞书 docx 暂不支持数学公式）
- 极度复杂的嵌套结构可能会被简化
- 表格功能暂未完全支持

### Q: 如何只迁移特定文件夹？
A: 在运行迁移前，将想要迁移的文件夹复制出来，然后指定该目录路径。

## License

MIT
