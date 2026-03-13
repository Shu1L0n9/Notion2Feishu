import { Client } from '@notionhq/client';

class NotionClient {
  constructor(apiKey) {
    this.client = new Client({ auth: apiKey });
  }

  /**
   * 获取数据库中的所有页面
   * @param {string} databaseId
   * @returns {Promise<Array>}
   */
  async getAllPages(databaseId) {
    const pages = [];
    let cursor = undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.databases.query({
        database_id: databaseId,
        start_cursor: cursor,
      });

      pages.push(...response.results);
      hasMore = response.has_more;
      cursor = response.next_cursor;
    }

    return pages;
  }

  /**
   * 获取页面的详细内容
   * @param {string} pageId
   * @returns {Promise<Object>}
   */
  async getPageContent(pageId) {
    const blocks = [];
    let cursor = undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
      });

      blocks.push(...response.results);
      hasMore = response.has_more;
      cursor = response.next_cursor;
    }

    return blocks;
  }

  /**
   * 获取数据库的属性配置
   * @param {string} databaseId
   * @returns {Promise<Object>}
   */
  async getDatabaseProperties(databaseId) {
    const database = await this.client.databases.retrieve({
      database_id: databaseId,
    });

    return database.properties;
  }

  /**
   * 提取页面的属性值
   * @param {Object} page
   * @returns {Object}
   */
  extractPageProperties(page) {
    const properties = {};

    for (const [key, value] of Object.entries(page.properties)) {
      properties[key] = this.extractPropertyValue(value);
    }

    return properties;
  }

  /**
   * 提取属性值
   * @param {Object} property
   * @returns {any}
   */
  extractPropertyValue(property) {
    const type = property.type;

    switch (type) {
      case 'title':
        return property.title.map((t) => t.plain_text).join('');
      case 'rich_text':
        return property.rich_text.map((t) => t.plain_text).join('');
      case 'number':
        return property.number;
      case 'checkbox':
        return property.checkbox;
      case 'select':
        return property.select ? property.select.name : null;
      case 'multi_select':
        return property.multi_select.map((s) => s.name);
      case 'date':
        return property.date ? property.date.start : null;
      case 'email':
        return property.email;
      case 'phone_number':
        return property.phone_number;
      case 'url':
        return property.url;
      case 'relation':
        return property.relation.map((r) => r.id);
      case 'rollup':
      case 'formula':
        return property[type];
      default:
        return null;
    }
  }
}

export default NotionClient;
