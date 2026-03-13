/**
 * 属性类型映射：从 Notion 类型映射到飞书类型
 */
export const propertyTypeMapping = {
  title: 'text', // 飞书文本字段
  rich_text: 'text',
  number: 'number',
  checkbox: 'checkbox',
  select: 'single_select',
  multi_select: 'multi_select',
  date: 'date',
  email: 'email',
  phone_number: 'phone_number',
  url: 'url',
  status: 'single_select',
  relation: 'text',
  rollup: 'text',
  formula: 'text',
  last_edited_time: 'date',
  created_time: 'date',
};

/**
 * 转换 Notion 属性到飞书字段配置
 * @param {string} name - 字段名称
 * @param {Object} notionProperty - Notion 属性对象
 * @returns {Object} 飞书字段配置
 */
export function convertPropertyToField(name, notionProperty) {
  const type = notionProperty.type;
  const feishuType = propertyTypeMapping[type] || 'text';

  const fieldConfig = {
    field_name: name,
    type: feishuType,
  };

  // 根据类型添加特定配置
  switch (type) {
    case 'select':
    case 'multi_select':
    case 'status':
      if (notionProperty[type]?.options) {
        fieldConfig.ui_type = type === 'multi_select' ? 'multi_select' : 'select';
        fieldConfig.property = {
          options: notionProperty[type].options.map((opt) => ({
            name: opt.name,
            color: opt.color || 'default',
          })),
        };
      }
      break;
    case 'number':
      fieldConfig.property = {
        precision: 2,
      };
      break;
    case 'date':
      fieldConfig.ui_type = 'date';
      break;
    case 'checkbox':
      fieldConfig.ui_type = 'checkbox';
      break;
  }

  return fieldConfig;
}

/**
 * 转换 Notion 数据值到飞书格式
 * @param {any} value - Notion 属性值
 * @param {string} type - 属性类型
 * @returns {any} 飞书格式的值
 */
export function convertPropertyValue(value, type) {
  if (value === null || value === undefined) {
    return null;
  }

  switch (type) {
    case 'title':
    case 'rich_text':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'number':
      return Number(value);
    case 'checkbox':
      return Boolean(value);
    case 'select':
    case 'multi_select':
      if (Array.isArray(value)) {
        return value.join(';');
      }
      return value;
    case 'date':
      return value; // 保持日期格式不变
    case 'email':
    case 'phone_number':
    case 'url':
      return String(value);
    case 'relation':
      if (Array.isArray(value)) {
        return value.join(';');
      }
      return value;
    default:
      return String(value);
  }
}

/**
 * 映射 Notion 属性名称到飞书字段名称
 * @param {string} notionName - Notion 属性名称
 * @returns {string} 飞书字段名称
 */
export function mapPropertyName(notionName) {
  // 移除特殊字符，转换为 snake_case
  return notionName
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 50); // 飞书字段名称有长度限制
}
