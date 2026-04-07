import axios from "axios";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import dotenv from "dotenv";

dotenv.config();

const appID = process.env.FEISHU_APP_ID || "";
const appSecret = process.env.FEISHU_APP_SECRET || "";
const redirectUri = process.env.REDIRECT_URI || "http://localhost:91/callback";
const port = Number(process.env.PORT || 91);
const oauthScope = process.env.FEISHU_OAUTH_SCOPE
  || "wiki:wiki wiki:node:create docx:document:write_only docs:document.media:upload";

function logAxiosError(response) {
  const data = response?.data;
  if (data) {
    console.error("Error details:", data);
    return;
  }

  console.error("Error:", response?.status, response?.statusText);
}

async function getUserAccessToken(code) {
  const url = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
  const payload = {
    grant_type: "authorization_code",
    client_id: appID,
    client_secret: appSecret,
    code,
    redirect_uri: redirectUri,
  };

  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

  const result = response.data;
  if (result.code !== 0) {
    throw new Error(`failed to get user_access_token: ${result.msg || "unknown error"}`);
  }

  return {
    accessToken: result.access_token || result.data?.access_token,
    scope: result.scope || result.data?.scope,
    tokenType: result.token_type || result.data?.token_type,
    expiresIn: result.expires_in || result.data?.expires_in,
    refreshToken: result.refresh_token || result.data?.refresh_token,
  };
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function openBrowser(url) {
  const platform = process.platform;
  let command = "";

  if (platform === "win32") {
    command = `start "" "${url}"`;
  } else if (platform === "darwin") {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.warn("Failed to open browser automatically:", error.message);
    }
  });
}

async function updateEnvToken(token) {
  const envPath = path.resolve(process.cwd(), ".env");
  let content = "";
  try {
    content = await fs.readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const nextLine = `FEISHU_USER_ACCESS_TOKEN=${token}`;
  if (!content) {
    await fs.writeFile(envPath, `${nextLine}\n`, "utf8");
    return { updated: true, created: true };
  }

  const lineRegex = /^FEISHU_USER_ACCESS_TOKEN=.*$/m;
  if (lineRegex.test(content)) {
    const updated = content.replace(lineRegex, nextLine);
    if (updated !== content) {
      await fs.writeFile(envPath, updated, "utf8");
    }
    return { updated: true, created: false };
  }

  const appended = `${content.replace(/\s*$/, "")}\n${nextLine}\n`;
  await fs.writeFile(envPath, appended, "utf8");
  return { updated: true, created: false };
}

const sockets = new Set();
const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", redirectUri);

    if (requestUrl.pathname !== "/callback") {
      sendHtml(res, 404, "<h1>Not Found</h1>");
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      sendHtml(res, 400, "<h1>Missing code</h1><p>No authorization code found.</p>");
      return;
    }

    console.log("Received authorization code. Exchanging for token...");
    const tokenResult = await getUserAccessToken(code);
    const token = tokenResult.accessToken;

    sendHtml(
      res,
      200,
      `<h1>Success</h1><p>user_access_token has been printed in the terminal.</p><pre>${token}</pre>`,
    );

    console.log("\nuser_access_token:");
    console.log(token);
    console.log("token_type:", tokenResult.tokenType || "(unknown)");
    console.log("scope:", tokenResult.scope || "(not returned)");
    console.log("expires_in:", tokenResult.expiresIn || "(unknown)");
    if (tokenResult.refreshToken) {
      console.log("refresh_token: [returned]");
    } else {
      console.log("refresh_token: (not returned)");
    }
    try {
      await updateEnvToken(token);
      console.log(".env updated: FEISHU_USER_ACCESS_TOKEN");
    } catch (envError) {
      console.error("Failed to update .env:", envError.message);
    }
    setTimeout(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(() => process.exit(0));
    }, 200);
  } catch (error) {
    if (error.response) {
      logAxiosError(error.response);
    } else {
      console.error(error.message);
    }

    sendHtml(res, 500, "<h1>Failed</h1><p>Check the terminal for details.</p>");
  }
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

server.listen(port, () => {
  if (!appID || !appSecret) {
    console.error("Missing FEISHU_APP_ID or FEISHU_APP_SECRET in .env");
    server.close(() => process.exit(1));
    return;
  }
  console.log(`Callback server listening on http://localhost:${port}`);
  console.log(`Redirect URI: ${redirectUri}`);
  console.log(`OAuth scope: ${oauthScope}`);

  const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?client_id=${encodeURIComponent(appID)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=1&scope=${encodeURIComponent(oauthScope)}`;

  console.log("\nOpen this URL in your browser to authorize:");
  console.log(authUrl);
  openBrowser(authUrl);
});
