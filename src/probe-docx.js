import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const baseURL = 'https://open.feishu.cn/open-apis';

async function getToken() {
  const res = await axios.post(`${baseURL}/auth/v3/tenant_access_token/internal`, {
    app_id: process.env.FEISHU_APP_ID,
    app_secret: process.env.FEISHU_APP_SECRET,
  });
  return res.data.tenant_access_token;
}

async function main() {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}` };

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
  const documentId = doc.data.data.document.document_id;

  const endpoint = `${baseURL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`;

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
