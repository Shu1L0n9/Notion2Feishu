import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { imageSize } from 'image-size';

class FeishuDocClient {
  constructor(appId, appSecret, options = {}) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.userAccessToken = options.userAccessToken || '';
    this.accessToken = null;
    this.tokenExpireTime = 0;
    this.baseURL = 'https://open.feishu.cn/open-apis';
    this.retryableCodes = new Set([1254290, 1254607, 1255040]);
    this.personalSpace = null;
    this.debugMedia = /^(1|true|yes)$/i.test(process.env.FEISHU_DEBUG_MEDIA || '');
  }

  _debug(message, extra = null) {
    if (!this.debugMedia) return;
    if (extra === null) {
      console.log(`[media-debug] ${message}`);
      return;
    }
    console.log(`[media-debug] ${message}`, extra);
  }

  async getAccessToken() {
    if (this.userAccessToken) {
      return this.userAccessToken;
    }

    const now = Date.now();
    if (this.accessToken && now < this.tokenExpireTime) {
      return this.accessToken;
    }

    const response = await axios.post(`${this.baseURL}/auth/v3/tenant_access_token/internal`, {
      app_id: this.appId,
      app_secret: this.appSecret,
    });

    if (response.data.code !== 0) {
      throw new Error(`Failed to get access token: ${response.data.msg}`);
    }

    this.accessToken = response.data.tenant_access_token;
    this.tokenExpireTime = now + response.data.expire * 1000 - 60000;
    return this.accessToken;
  }

  async request(method, url, data = undefined, params = undefined, maxRetries = 4) {
    const token = await this.getAccessToken();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios({
          method,
          url,
          data,
          params,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.data?.code === 0) {
          return response.data.data;
        }

        const err = new Error(`Feishu API error(${response.data?.code}): ${response.data?.msg}`);
        err.code = response.data?.code;
        throw err;
      } catch (error) {
        const code = error?.code || error?.response?.data?.code;
        const httpStatus = error?.response?.status;
        const retryable = this.retryableCodes.has(code)
          || httpStatus === 429
          || (httpStatus >= 500 && httpStatus < 600)
          || error?.code === 'ECONNRESET'
          || error?.code === 'ETIMEDOUT';
        if (!retryable || attempt === maxRetries) {
          throw error;
        }

        const delay = 500 * (2 ** attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async getPersonalSpace() {
    if (this.personalSpace?.spaceId) {
      return this.personalSpace;
    }

    const envSpaceId = process.env.FEISHU_WIKI_SPACE_ID || '';
    const envRootNodeToken = process.env.FEISHU_WIKI_ROOT_NODE_TOKEN || '';
    const homeNodeToken = process.env.FEISHU_WIKI_HOME_NODE_TOKEN || '';

    if (envSpaceId) {
      this.personalSpace = {
        spaceId: envSpaceId,
        rootNodeToken: envRootNodeToken,
      };
      return this.personalSpace;
    }

    if (homeNodeToken) {
      const data = await this.request('get', `${this.baseURL}/wiki/v2/spaces/get_node`, undefined, {
        token: homeNodeToken,
      });

      const node = data?.node || {};
      const spaceId = node.space_id || '';
      const rootNodeToken = envRootNodeToken || node.node_token || homeNodeToken;

      if (!spaceId) {
        throw new Error('Failed to resolve space_id from FEISHU_WIKI_HOME_NODE_TOKEN via wiki/v2/spaces/get_node');
      }

      this.personalSpace = {
        spaceId,
        rootNodeToken,
      };
      return this.personalSpace;
    }

    throw new Error('Missing FEISHU_WIKI_SPACE_ID. Set numeric space_id, or set FEISHU_WIKI_HOME_NODE_TOKEN so space_id can be resolved via get_node(token).');
  }

  async createDoc(title, parentNodeToken = '') {
    const personalSpace = await this.getPersonalSpace();
    const parent = parentNodeToken || personalSpace.rootNodeToken || '';

    const data = await this.request('post', `${this.baseURL}/wiki/v2/spaces/${personalSpace.spaceId}/nodes`, {
      obj_type: 'docx',
      node_type: 'origin',
      parent_node_token: parent,
      title,
    });

    const node = data?.node || data;
    return {
      document_id: node.obj_token,
      node_token: node.node_token,
      title: node.title || title,
    };
  }

  async writeDocument(documentId, textContent, options = {}) {
    const blocks = await this._markdownToBlocks(textContent, {
      ...options,
      documentId,
    });
      const batchSize = 5;
      const buffer = [];

      const flushBuffer = async () => {
        while (buffer.length) {
          const chunk = buffer.splice(0, batchSize);
          try {
            await this.request('post', `${this.baseURL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
              children: chunk,
            });
          } catch (err) {
            this._debug('Batch append failed, switching to single-block mode', {
              documentId,
              pageTitle: options.pageTitle || '',
              chunkSize: chunk.length,
            });

            for (const block of chunk) {
              try {
                await this.request('post', `${this.baseURL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
                  children: [block],
                });
              } catch (singleErr) {
                const code = singleErr?.response?.data?.code || singleErr?.code || 'unknown';
                this._debug('Single block append failed', {
                  documentId,
                  blockType: block.block_type,
                  code,
                  msg: singleErr?.response?.data?.msg || singleErr?.message,
                });
                throw singleErr;
              }
            }
          }
        }
      };

      for (const block of blocks) {
        if (block?._mediaPending) {
          await flushBuffer();
          try {
            await this._appendMediaPlaceholder(documentId, block, options);
          } catch (err) {
            const code = err?.response?.data?.code || err?.code || 'unknown';
            this._debug('Media append via placeholder failed', {
              documentId,
              blockType: block.isImage ? 27 : 23,
              code,
              msg: err?.response?.data?.msg || err?.message,
            });
            buffer.push({
              block_type: 2,
              text: {
                elements: this._buildTextElement(`${block.url || block.absPath} [上传失败 code=${code}]`),
              },
            });
          }
          continue;
        }

        if (block?._docRefPending) {
          await flushBuffer();
          try {
            await this._appendDocReferenceByNestedText(documentId, block);
          } catch (err) {
            const code = err?.response?.data?.code || err?.code || 'unknown';
            this._debug('Doc reference append failed', {
              documentId,
              code,
              msg: err?.response?.data?.msg || err?.message,
              url: block.url || '',
            });
            buffer.push({
              block_type: 2,
              text: {
                elements: this._buildTextElement(block.linkText ? `${block.linkText}: ${block.url} [插入失败 code=${code}]` : `${block.url} [插入失败 code=${code}]`),
              },
            });
          }
          continue;
        }

        buffer.push(block);

        if (buffer.length >= batchSize) {
          await flushBuffer();
        }
      }

      await flushBuffer();
    }

  async _appendDocReferenceByNestedText(documentId, refBlock) {
    const title = refBlock.childTitle || refBlock.linkText || '子文档';
    const nodeToken = refBlock.childNodeToken || '';
    const docToken = refBlock.childDocId || '';
    const link = nodeToken
      ? `https://feishu.cn/wiki/${nodeToken}`
      : (docToken ? `https://feishu.cn/docx/${docToken}` : '');

    const first = await this.request('post', `${this.baseURL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
      children: [{
        block_type: 2,
        text: {
          elements: this._buildTextElement(title),
        },
      }],
    });

    const parentBlockId = first?.children?.[0]?.block_id || '';
    if (!parentBlockId) {
      throw new Error('Failed to create parent text block for doc reference');
    }

    const nestedContent = link || (refBlock.url || '');
    if (!nestedContent) {
      return;
    }

    await this.request('post', `${this.baseURL}/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children`, {
      children: [{
        block_type: 2,
        text: {
          elements: this._buildTextElement(nestedContent),
        },
      }],
    });
  }

  async _appendMediaPlaceholder(documentId, mediaBlock, options = {}) {
    const isImage = !!mediaBlock.isImage;
    const absPath = mediaBlock.absPath || '';
    const url = mediaBlock.url || '';
    const parentType = isImage ? 'docx_image' : 'docx_file';
    const pageTitle = options.pageTitle || '';
    const imgWidth = Number(mediaBlock?.imageSize?.width || 600);
    const imgHeight = Number(mediaBlock?.imageSize?.height || 400);

    this._debug('Creating placeholder block', {
      documentId,
      parentType,
      absPath,
      url,
      pageTitle,
    });

    const placeholderPayload = isImage
      ? {
        block_type: 27,
        image: {
          width: imgWidth,
          height: imgHeight,
          align: 2,
        },
      }
      : { block_type: 23, file: { token: '' } };

    const placeholder = await this.request('post', `${this.baseURL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
      children: [placeholderPayload],
    });

    const child = placeholder?.children?.[0] || {};
    const placeholderId = isImage ? (child.block_id || '') : (child.children?.[0] || '');
    const viewBlockId = isImage ? '' : (child.block_id || '');

    if (!placeholderId) {
      throw new Error('Failed to create media placeholder block');
    }

    this._debug('Placeholder created', {
      placeholderId,
      viewBlockId,
      parentType,
    });

    const fileToken = await this.uploadMedia(absPath, parentType, placeholderId);

    const replaceBody = isImage
      ? { replace_image: { token: fileToken } }
      : { replace_file: { token: fileToken } };

    await this.request('patch', `${this.baseURL}/docx/v1/documents/${documentId}/blocks/${placeholderId}`, replaceBody);

    this._debug('Media replace applied', {
      placeholderId,
      fileToken,
      parentType,
    });
  }

  _buildTextElement(content) {
    const raw = String(content ?? '');
    const elements = [];
    const pushText = (text, style = null) => {
      if (!text) return;
      const textRun = { content: text };
      if (style && Object.keys(style).length) {
        textRun.text_element_style = style;
      }
      elements.push({ text_run: textRun });
    };

    const tokenRegex = /(\[[^\]]+\]\([^\)]+\)|\*\*[^\*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^\*\n]+\*)/g;
    let lastIndex = 0;

    for (const match of raw.matchAll(tokenRegex)) {
      const token = match[0] || '';
      const start = match.index ?? 0;
      if (start > lastIndex) {
        pushText(raw.slice(lastIndex, start));
      }

      if (token.startsWith('**') && token.endsWith('**')) {
        pushText(token.slice(2, -2), { bold: true });
      } else if (token.startsWith('~~') && token.endsWith('~~')) {
        pushText(token.slice(2, -2), { strikethrough: true });
      } else if (token.startsWith('`') && token.endsWith('`')) {
        pushText(token.slice(1, -1), { inline_code: true });
      } else if (token.startsWith('*') && token.endsWith('*')) {
        pushText(token.slice(1, -1), { italic: true });
      } else if (token.startsWith('[')) {
        const m = token.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
        if (m) {
          const linkText = m[1] || '';
          const linkUrl = m[2] || '';
          pushText(linkText, {
            link: {
              url: linkUrl,
            },
          });
        } else {
          pushText(token);
        }
      } else {
        pushText(token);
      }

      lastIndex = start + token.length;
    }

    if (lastIndex < raw.length) {
      pushText(raw.slice(lastIndex));
    }

    if (!elements.length) {
      pushText(raw || ' ');
    }

    return elements;
  }

  _isImageExt(ext) {
    return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext.toLowerCase());
  }

  _isMarkdownExt(ext) {
    return ['.md', '.markdown', '.mdx'].includes(ext.toLowerCase());
  }

  async _getImageRenderSize(absPath) {
    try {
      const fileBuffer = await fs.readFile(absPath);
      const size = imageSize(fileBuffer);
      let width = Number(size?.width || 0);
      let height = Number(size?.height || 0);
      const orientation = Number(size?.orientation || 1);

      // EXIF orientation 5/6/7/8 means 90° rotation; swap width/height for display ratio.
      if ([5, 6, 7, 8].includes(orientation)) {
        [width, height] = [height, width];
      }

      if (!width || !height) {
        return { width: 600, height: 400 };
      }

      const maxWidth = 1000;
      const renderWidth = Math.min(width, maxWidth);
      const renderHeight = Math.max(1, Math.round((renderWidth / width) * height));
      return { width: renderWidth, height: renderHeight };
    } catch (err) {
      this._debug('Read image size failed, fallback to default', {
        absPath,
        msg: err?.message || String(err),
      });
      return { width: 600, height: 400 };
    }
  }

  _tryDecodeURIComponent(raw) {
    let out = raw;
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

  _extractSingleMarkdownLink(line) {
    const imgMatch = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imgMatch) {
      return { isImage: true, text: imgMatch[1] || '', url: imgMatch[2] };
    }

    const linkMatch = line.match(/^\s*\[([^\]]+)\]\(([^)]+)\)\s*$/);
    if (linkMatch) {
      return { isImage: false, text: linkMatch[1] || '', url: linkMatch[2] };
    }

    return null;
  }

  async uploadMedia(filePath, parentType, parentNode = '') {
    const token = await this.getAccessToken();
    const fileBuffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);
    const form = new FormData();
    form.append('file_name', fileName);
    form.append('parent_type', parentType);
    if (parentNode) {
      form.append('parent_node', parentNode);
    }
    form.append('size', String(fileBuffer.length));
    form.append('file', new Blob([fileBuffer]), fileName);

    this._debug('Uploading media', {
      filePath,
      parentType,
      parentNode,
      size: fileBuffer.length,
    });

    const response = await axios.post(`${this.baseURL}/drive/v1/medias/upload_all`, form, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.data?.code !== 0) {
      this._debug('Upload failed', {
        code: response.data?.code,
        msg: response.data?.msg,
      });
      throw new Error(`Upload media failed(${response.data?.code}): ${response.data?.msg}`);
    }

    this._debug('Upload succeeded', {
      fileToken: response.data?.data?.file_token,
      parentType,
      parentNode,
    });

    return response.data?.data?.file_token;
  }

  async _buildMediaBlockFromMarkdownLink(link, options) {
    const url = link.url || '';
    const markdownFilePath = options.markdownFilePath || '';
    const resolveMarkdownDocLink = options.resolveMarkdownDocLink;

    if (!markdownFilePath || /^https?:\/\//i.test(url)) {
      return {
        block_type: 2,
        text: {
          elements: this._buildTextElement(link.text ? `${link.text}: ${url}` : url),
        },
      };
    }

    const cleaned = this._tryDecodeURIComponent(url.split('?')[0].split('#')[0]);
    const absPath = path.resolve(path.dirname(markdownFilePath), cleaned);

    try {
      await fs.access(absPath);
    } catch {
      return {
        block_type: 2,
        text: {
          elements: this._buildTextElement(link.text ? `${link.text}: ${url}` : url),
        },
      };
    }

    const ext = path.extname(absPath).toLowerCase();
    if (this._isMarkdownExt(ext)) {
      if (typeof resolveMarkdownDocLink === 'function') {
        const resolved = await resolveMarkdownDocLink({
          url,
          absPath,
          linkText: link.text || '',
        });
        if (resolved) {
          const resolvedObj = typeof resolved === 'string'
            ? { documentId: resolved }
            : resolved;
          this._debug('Resolved markdown child doc link', {
            url,
            absPath,
            childDocToken: resolvedObj.documentId || '',
            childNodeToken: resolvedObj.nodeToken || '',
          });
          return {
            _docRefPending: true,
            url,
            absPath,
            linkText: link.text || '',
            childTitle: resolvedObj.title || link.text || '',
            childDocId: resolvedObj.documentId || '',
            childNodeToken: resolvedObj.nodeToken || '',
          };
        }
      }

      return {
        block_type: 2,
        text: {
          elements: this._buildTextElement(link.text ? `${link.text}: ${url}` : url),
        },
      };
    }

    const isImage = link.isImage || this._isImageExt(ext);
    const imageSize = isImage
      ? await this._getImageRenderSize(absPath)
      : null;
    this._debug('Resolved markdown media link', {
      url,
      absPath,
      ext,
      isImage,
      imageSize,
      documentId: options.documentId || '',
      pageTitle: options.pageTitle || '',
    });

    return {
      _mediaPending: true,
      isImage,
      absPath,
      url,
      imageSize,
      displayText: link.text || '',
    };
  }

  async _markdownToBlocks(markdown, options = {}) {
    const lines = String(markdown || '').split(/\r?\n/);
    const blocks = [];
    let inCodeFence = false;
    let codeFenceLines = [];
    let inMathFence = false;
    let mathFenceLines = [];

    const flushCodeFence = () => {
      if (!codeFenceLines.length) return;
      blocks.push({
        block_type: 2,
        text: {
          elements: [{
            text_run: {
              content: codeFenceLines.join('\n'),
              text_element_style: {
                inline_code: true,
              },
            },
          }],
        },
      });
      codeFenceLines = [];
    };

    const flushMathFence = () => {
      if (!mathFenceLines.length) return;
      blocks.push({
        block_type: 2,
        text: {
          elements: this._buildTextElement(`$$${mathFenceLines.join('\n')}$$`),
        },
      });
      mathFenceLines = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();

      if (inCodeFence) {
        if (/^```/.test(line.trim())) {
          inCodeFence = false;
          flushCodeFence();
        } else {
          codeFenceLines.push(rawLine);
        }
        continue;
      }

      if (inMathFence) {
        if (/^\s*\$\$\s*$/.test(line)) {
          inMathFence = false;
          flushMathFence();
        } else {
          mathFenceLines.push(rawLine);
        }
        continue;
      }

      if (/^```/.test(line.trim())) {
        inCodeFence = true;
        codeFenceLines = [];
        continue;
      }

      if (/^\s*\$\$\s*$/.test(line)) {
        inMathFence = true;
        mathFenceLines = [];
        continue;
      }

      if (!line.trim()) {
        continue;
      }

      if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
        blocks.push({
          block_type: 2,
          text: {
            elements: this._buildTextElement('────────'),
          },
        });
        continue;
      }

      const singleLink = this._extractSingleMarkdownLink(line.trim());
      if (singleLink) {
        blocks.push(await this._buildMediaBlockFromMarkdownLink(singleLink, options));
        continue;
      }

      if (line.startsWith('### ')) {
        blocks.push({
          block_type: 5,
          heading3: {
            elements: this._buildTextElement(line.slice(4)),
          },
        });
        continue;
      }

      if (line.startsWith('##### ')) {
        blocks.push({
          block_type: 7,
          heading5: {
            elements: this._buildTextElement(line.slice(6)),
          },
        });
        continue;
      }

      if (line.startsWith('#### ')) {
        blocks.push({
          block_type: 6,
          heading4: {
            elements: this._buildTextElement(line.slice(5)),
          },
        });
        continue;
      }

      if (line.startsWith('## ')) {
        blocks.push({
          block_type: 4,
          heading2: {
            elements: this._buildTextElement(line.slice(3)),
          },
        });
        continue;
      }

      if (line.startsWith('# ')) {
        blocks.push({
          block_type: 3,
          heading1: {
            elements: this._buildTextElement(line.slice(2)),
          },
        });
        continue;
      }

      if (/^\d+\.\s+/.test(line)) {
        const match = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
        const depth = match ? Math.floor((match[1] || '').length / 2) : 0;
        const content = match ? match[3] : line.replace(/^\d+\.\s+/, '');
        const prefixed = depth > 0 ? `${'  '.repeat(depth)}${content}` : content;
        blocks.push({
          block_type: 13,
          ordered: {
            elements: this._buildTextElement(prefixed),
          },
        });
        continue;
      }

      const todoMatch = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
      if (todoMatch) {
        const checked = /x/i.test(todoMatch[1] || '');
        const text = todoMatch[2] || '';
        const prefix = checked ? '☑ ' : '☐ ';
        blocks.push({
          block_type: 12,
          bullet: {
            elements: this._buildTextElement(`${prefix}${text}`),
          },
        });
        continue;
      }

      if (line.startsWith('- ') || line.startsWith('* ') || /^\s+[-*]\s+/.test(line)) {
        const match = line.match(/^(\s*)[-*]\s+(.*)$/);
        const depth = match ? Math.floor((match[1] || '').length / 2) : 0;
        const content = match ? match[2] : line.slice(2);
        const prefixed = depth > 0 ? `${'  '.repeat(depth)}${content}` : content;
        blocks.push({
          block_type: 12,
          bullet: {
            elements: this._buildTextElement(prefixed),
          },
        });
        continue;
      }

      if (line.startsWith('> ')) {
        blocks.push({
          block_type: 15,
          quote: {
            elements: this._buildTextElement(line.slice(2)),
          },
        });
        continue;
      }

      blocks.push({
        block_type: 2,
        text: {
          elements: this._buildTextElement(line),
        },
      });
    }

    if (inCodeFence) {
      flushCodeFence();
    }
    if (inMathFence) {
      flushMathFence();
    }

    if (!blocks.length) {
      blocks.push({
        block_type: 2,
        text: {
          elements: this._buildTextElement(' '),
        },
      });
    }

    return blocks;
  }

  async appendChildDocBlocks(documentId, childDocs) {
    if (!childDocs || !childDocs.length) {
      return;
    }

    const children = childDocs.map((child) => ({
      block_type: 22,
      page: {
        token: child.documentId,
      },
    }));

    await this.request('post', `${this.baseURL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
      children,
    });
  }
}

export default FeishuDocClient;
