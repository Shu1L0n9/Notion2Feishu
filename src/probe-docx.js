import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const baseURL = 'https://open.feishu.cn/open-apis';
const userAccessToken = process.env.FEISHU_USER_ACCESS_TOKEN || '';
const testDocId = process.env.FEISHU_TEST_DOC_ID || process.env.FEISHU_DOC_ID || '';
const testText = process.env.FEISHU_TEST_TEXT || `Probe write at ${new Date().toISOString()}`;

async function getToken() {
  if (userAccessToken) {
    return userAccessToken;
  }

  const res = await axios.post(`${baseURL}/auth/v3/tenant_access_token/internal`, {
    app_id: process.env.FEISHU_APP_ID,
    app_secret: process.env.FEISHU_APP_SECRET,
  });

  if (res.data.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: ${res.data.msg || 'unknown error'}`);
  }

  return res.data.tenant_access_token;
}

async function createProbeDocument(headers) {
  const folder = await axios.post(
    `${baseURL}/drive/v1/files/create_folder`,
    { name: `Probe_${Date.now()}`, folder_token: '' },
    { headers },
  );

  const folderToken = folder.data.data.token;

  const doc = await axios.post(
    `${baseURL}/docx/v1/documents`,
    { title: 'ProbeDoc', folder_token: folderToken },
    { headers },
  );

  return {
    folderToken,
    documentId: doc.data.data.document.document_id,
  };
}

async function appendProbeText(documentId, headers) {
  const endpoint = `${baseURL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`;
  const payload = {
    children: [
      {
        block_type: 2,
        text: {
          elements: [
            {
              type: 1,
              text_run: { content: testText },
            },
          ],
        },
      },
    ],
  };

  return axios.post(endpoint, payload, { headers });
}

async function main() {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}` };

  const documentId = testDocId || (await createProbeDocument(headers)).documentId;

  const payloads = [
    {
      name: 'v1_text_style_string',
      data: {
        index: 0,
        children: [
          {
            block_type: 'text',
            text: {
              elements: [
                {
                  type: 'text_run',
                  text_run: { text: 'hello world' },
                },
              ],
            },
          },
        ],
      },
    },
    {
      name: 'v2_text_style_numeric',
      data: {
        index: 0,
        children: [
          {
            block_type: 2,
            text: {
              elements: [
                {
                  text_run: { content: 'hello world' },
                  type: 1,
                },
              ],
            },
          },
        ],
      },
    },
    {
      name: 'v3_paragraph_style',
      data: {
        index: 0,
        children: [
          {
            block_type: 2,
            paragraph: {
              elements: [
                {
                  text_run: { content: 'hello world' },
                  type: 1,
                },
              ],
            },
          },
        ],
      },
    },
  ];

  console.log('documentId=', documentId);
  console.log('usingTokenType=', userAccessToken ? 'user_access_token' : 'tenant_access_token');

  await appendProbeText(documentId, headers);
  console.log('OK appendProbeText', JSON.stringify({ documentId, testText }));

  const endpoint = `${baseURL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`;

  for (const p of payloads) {
    try {
      const r = await axios.post(endpoint, p.data, { headers });
      console.log(`OK ${p.name}`, JSON.stringify(r.data));
      return;
    } catch (e) {
      const body = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      console.log(`FAIL ${p.name}:`, body);
    }
  }
}

main().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
