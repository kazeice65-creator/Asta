import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

let cachedTenantAccessToken = null;
let cachedTenantAccessTokenExpireAt = 0;

const handledMessageIds = new Set();

function cleanLarkText(text) {
  if (!text) return "";

  return text
    .replace(/<at[^>]*>.*?<\/at>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getTenantAccessToken() {
  const now = Date.now();

  if (cachedTenantAccessToken && now < cachedTenantAccessTokenExpireAt) {
    return cachedTenantAccessToken;
  }

  const response = await axios.post(
    "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    {
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    }
  );

  if (response.data.code !== 0) {
    throw new Error(`获取 Lark token 失败：${JSON.stringify(response.data)}`);
  }

  cachedTenantAccessToken = response.data.tenant_access_token;

  const expireSeconds = response.data.expire || 7200;
  cachedTenantAccessTokenExpireAt = now + (expireSeconds - 300) * 1000;

  return cachedTenantAccessToken;
}

async function sendLarkText(chatId, text) {
  const token = await getTenantAccessToken();

  const response = await axios.post(
    "https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({
        text,
      }),
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (response.data.code !== 0) {
    throw new Error(`发送 Lark 消息失败：${JSON.stringify(response.data)}`);
  }
}

async function askAI(userText) {
  const response = await openai.responses.create({
    model: process.env.AI_MODEL,
    input: [
      {
        role: "system",
        content: `
你是 Kaze 的 Lark AI Agent，名字叫 Kaze AI Agent。

你的主要工作：
1. 帮 Kaze 分析 crypto、meme、Base 链项目
2. 生成英文区 X 推文，并附中文翻译
3. 帮 Kaze 总结信息、判断风险、输出行动建议
4. 回答要自然，不要官方腔
5. 不要承诺收益
6. 涉及交易时必须提醒风险
7. 不要替用户做最终买卖决定

输出风格：
- 简洁
- 直接
- 像 crypto native
- 适合 Lark 群聊阅读
        `,
      },
      {
        role: "user",
        content: userText,
      },
    ],
  });

  return response.output_text || "我刚刚没有生成有效回复，你可以再发一次。";
}

app.get("/", (req, res) => {
  res.send("Kaze AI Agent is running.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "kaze-lark-agent",
  });
});

app.post("/lark/events", async (req, res) => {
  const body = req.body;

  try {
    // Lark URL 校验
    if (body.challenge) {
      return res.json({
        challenge: body.challenge,
      });
    }

    // 验证请求是否来自 Lark
    if (body.token && body.token !== process.env.LARK_VERIFICATION_TOKEN) {
      return res.status(401).json({
        error: "invalid verification token",
      });
    }

    const event = body.event;

    if (!event || !event.message) {
      return res.json({ ok: true });
    }

    const message = event.message;
    const messageId = message.message_id;
    const chatId = message.chat_id;
    const messageType = message.message_type;

    // 防止 Lark 重试导致重复回复
    if (messageId && handledMessageIds.has(messageId)) {
      return res.json({ ok: true });
    }

    if (messageId) {
      handledMessageIds.add(messageId);
    }

    // 先告诉 Lark：我已收到
    res.json({ ok: true });

    if (messageType !== "text") {
      await sendLarkText(chatId, "我现在先支持文字消息，图片和文件后面再接。");
      return;
    }

    const content = JSON.parse(message.content || "{}");
    const userText = cleanLarkText(content.text || "");

    if (!userText) {
      await sendLarkText(chatId, "你可以直接发问题，例如：分析这个 Base meme 合约：0x...");
      return;
    }

    const aiReply = await askAI(userText);

    await sendLarkText(chatId, aiReply);
  } catch (error) {
    console.error("Lark event error:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        error: "internal server error",
      });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Kaze AI Agent running on port ${PORT}`);
});