import axios from 'axios';

class FeishuClient {
  constructor(appId, appSecret) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.accessToken = null;
    this.tokenExpireTime = 0;
    this.baseURL = 'https://open.feishu.cn/open-apis';
    this.retryableCodes = new Set([1254290, 1254607, 1255040]);
  }

  /**
   * 获取可访问的多维表格应用列表
   * @returns {Promise<Array>}
   */
  async listApps() {
    const data = await this._request('get', `${this.baseURL}/bitable/v1/apps`);
    return data.items || [];
  }

  /**
   * 创建多维表格应用（Base）
   * @param {string} appName
   * @param {string|null} folderToken
   * @returns {Promise<Object>}
   */
  async createApp(appName, folderToken = null) {
    const payload = {
      name: appName,
    };

    if (folderToken) {
      payload.folder_token = folderToken;
    }

    const data = await this._request('post', `${this.baseURL}/bitable/v1/apps`, payload);
    return data.app || data;
  }

  /**
   * 获取指定 app 的表格列表
   * @param {string} appToken
   * @returns {Promise<Array>}
   */
  async listTables(appToken) {
    const data = await this._request('get', `${this.baseURL}/bitable/v1/apps/${appToken}/tables`);
    return data.items || [];
  }

  /**
   * 创建表格（兼容不同请求体）
   * @param {string} appToken
   * @param {string} tableName
   * @returns {Promise<Object>}
   */
  async createTable(appToken, tableName) {
    const url = `${this.baseURL}/bitable/v1/apps/${appToken}/tables`;

    try {
      return await this._request('post', url, {
        table: {
          name: tableName,
        },
      });
    } catch (error) {
      // 兜底请求体，兼容不同版本
      return this._request('post', url, {
        name: tableName,
      });
    }
  }

  /**
   * 解析 FEISHU_TABLE_ID（格式: appToken/tableId）
   * @param {string} tableId
   * @returns {{appToken:string, tableId:string}}
   */
  parseTableId(tableId) {
    const [appToken, tableIdOnly] = (tableId || '').split('/');
    if (!appToken || !tableIdOnly) {
      throw new Error('FEISHU_TABLE_ID 格式错误，应为 appToken/tableId');
    }

    return { appToken, tableId: tableIdOnly };
  }

  /**
   * 获取访问令牌
   * @returns {Promise<string>}
   */
  async getAccessToken() {
    const now = Date.now();

    // 如果 token 有效期内，直接返回
    if (this.accessToken && now < this.tokenExpireTime) {
      return this.accessToken;
    }

    try {
      const response = await axios.post(`${this.baseURL}/auth/v3/tenant_access_token/internal`, {
        app_id: this.appId,
        app_secret: this.appSecret,
      });

      if (response.data.code === 0) {
        this.accessToken = response.data.tenant_access_token;
        this.tokenExpireTime = now + response.data.expire * 1000 - 60000; // 提前 1 分钟续期
        return this.accessToken;
      } else {
        throw new Error(`Failed to get access token: ${response.data.msg}`);
      }
    } catch (error) {
      console.error('Get access token error:', error.message);
      throw error;
    }
  }

  /**
   * 统一请求封装（带重试）
   * @private
   */
  async _request(method, url, data = undefined, maxRetries = 4) {
    const token = await this.getAccessToken();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios({
          method,
          url,
          data,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.data?.code === 0) {
          return response.data.data;
        }

        const code = response.data?.code;
        const msg = response.data?.msg || 'Unknown error';
        const error = new Error(`Feishu API error(${code}): ${msg}`);
        error.code = code;
        throw error;
      } catch (error) {
        const code = error?.code || error?.response?.data?.code;
        const retryable = this.retryableCodes.has(code) || error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT';

        if (!retryable || attempt === maxRetries) {
          throw error;
        }

        const delay = 500 * (2 ** attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * 创建多维表格记录
   * @param {string} tableId
   * @param {Object} fields
   * @returns {Promise<Object>}
   */
  async createRecord(tableId, fields) {
    const { appToken, tableId: tableIdOnly } = this.parseTableId(tableId);
    return this._request(
      'post',
      `${this.baseURL}/bitable/v1/apps/${appToken}/tables/${tableIdOnly}/records`,
      { fields },
    );
  }

  /**
   * 批量创建记录
   * @param {string} tableId
   * @param {Array<Object>} records
   * @returns {Promise<Array>}
   */
  async batchCreateRecords(tableId, records) {
    const { appToken, tableId: tableIdOnly } = this.parseTableId(tableId);
    const limitedRecords = records.slice(0, 500);
    const data = await this._request(
      'post',
      `${this.baseURL}/bitable/v1/apps/${appToken}/tables/${tableIdOnly}/records/batch_create`,
      {
        records: limitedRecords.map((fields) => ({ fields })),
      },
    );

    return data.records || [];
  }

  /**
   * 获取多维表格中的字段列表
   * @param {string} tableId
   * @returns {Promise<Array>}
   */
  async getTableFields(tableId) {
    const { appToken, tableId: tableIdOnly } = this.parseTableId(tableId);
    const data = await this._request(
      'get',
      `${this.baseURL}/bitable/v1/apps/${appToken}/tables/${tableIdOnly}/fields`,
    );

    return data.items || [];
  }

  /**
   * 创建新字段
   * @param {string} tableId
   * @param {Object} fieldConfig
   * @returns {Promise<Object>}
   */
  async createField(tableId, fieldConfig) {
    const { appToken, tableId: tableIdOnly } = this.parseTableId(tableId);
    const data = await this._request(
      'post',
      `${this.baseURL}/bitable/v1/apps/${appToken}/tables/${tableIdOnly}/fields`,
      fieldConfig,
    );

    return data.field;
  }
}

export default FeishuClient;
